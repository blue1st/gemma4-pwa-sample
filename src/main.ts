import './style.css'
import { registerSW } from 'virtual:pwa-register'


// PWA Register (will be called in window.onload)


// State management
let facingMode: 'user' | 'environment' = 'environment'
let currentStream: MediaStream | null = null
let worker: Worker | null = null
let isModelLoading = false
let isAnalyzing = false
let isCameraInitializing = false
let includeAudio = false
let backgroundAnalysisId: number | null = null
let captureIntervalId: number | null = null
let backgroundFrameBuffer: string[] = []
let videoFrameCount = 8
let BACKGROUND_ANALYSIS_INTERVAL = 5000;
let targetLanguage = 'Japanese'; // Default to Japanese or Browser

let audioContext: AudioContext | null = null
let audioBuffer: Float32Array | null = null
let audioWriteIdx = 0
let samplingRate = 16000
let lastDisplayedProgress = 0
let loadingFiles: Record<string, { loaded: number, total: number }> = {}
let isInitialized = false

// DOM Elements
const video = document.getElementById('main-video') as HTMLVideoElement
const tapSurface = document.getElementById('tap-surface') as HTMLDivElement
const descriptionText = document.getElementById('description-text') as HTMLParagraphElement
const connectionStatus = document.getElementById('connection-status') as HTMLDivElement
const modelSelector = document.getElementById('model-selector') as HTMLSelectElement
const switchCameraBtn = document.getElementById('switch-camera-btn') as HTMLButtonElement
const toggleAudioBtn = document.getElementById('toggle-audio-btn') as HTMLButtonElement
const bubbleContainer = document.getElementById('bubble-container') as HTMLDivElement
const loadProgressContainer = document.getElementById('load-progress-container') as HTMLDivElement
const loadProgressBar = document.getElementById('load-progress-bar') as HTMLDivElement
const loadProgressLabel = document.getElementById('load-progress-label') as HTMLDivElement

const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement
const settingsModal = document.getElementById('settings-modal') as HTMLDivElement
const closeSettingsBtn = document.getElementById('close-settings-btn') as HTMLButtonElement
const frameCountInput = document.getElementById('video-frame-count') as HTMLInputElement
const intervalInput = document.getElementById('analysis-interval') as HTMLInputElement
const frameCountVal = document.getElementById('frame-count-val') as HTMLSpanElement
const intervalVal = document.getElementById('interval-val') as HTMLSpanElement
const languageSelector = document.getElementById('response-language') as HTMLSelectElement

// Hidden canvases for processing
const cropCanvas = document.createElement('canvas')
const tapCanvas = document.createElement('canvas')

// Capture every X ms is now calculated dynamically in startFrameCapture

// Initialize Camera
async function initCamera() {
  if (isCameraInitializing) return
  isCameraInitializing = true
  
  if (currentStream) {
    currentStream.getTracks().forEach(track => track.stop())
  }
  try {
    currentStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: facingMode,
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    })
    video.srcObject = currentStream
    return new Promise<void>((resolve) => {
      video.onloadedmetadata = () => {
        video.play()
        updateStatus('Camera Active')
        isCameraInitializing = false
        resolve()
      }
      video.onerror = () => {
        updateStatus('Camera Error')
        isCameraInitializing = false
        resolve()
      }
    })
  } catch (err) {
    console.error('Camera Error:', err)
    updateStatus('Camera Error')
    isCameraInitializing = false
  }
}

// Update Status Text
function updateStatus(text: string) {
  // If model is loading, ignore generic camera messages to avoid overrides
  if (isModelLoading && text === 'Camera Active') return;

  connectionStatus.textContent = text
  
  if (text === 'Camera Active' || text === 'Model Loaded' || text === 'READY') {
    connectionStatus.style.color = '#00ff00'
    connectionStatus.style.background = 'rgba(0, 255, 0, 0.1)'
    connectionStatus.style.borderColor = 'rgba(0, 255, 0, 0.2)'
  } else if (text.toLowerCase().includes('error') || text.toLowerCase().includes('fail') || text.toLowerCase().includes('unauthorized')) {
    connectionStatus.style.color = '#ff4d4d'
    connectionStatus.style.background = 'rgba(255, 77, 77, 0.1)'
    connectionStatus.style.borderColor = 'rgba(255, 77, 77, 0.2)'
  } else {
    connectionStatus.style.color = '#ffcc00' 
    connectionStatus.style.background = 'rgba(255, 204, 0, 0.1)'
    connectionStatus.style.borderColor = 'rgba(255, 204, 0, 0.2)'
  }
}

// Worker Communication
function initWorker() {
  if (worker) return
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  
  worker.onmessage = (e) => {
    const { type, payload, error } = e.data
    switch (type) {
      case 'status':
        updateStatus(payload)
        break
      case 'progress':
        updateLoadingProgress(payload)
        break
      case 'loaded':
        isModelLoading = false
        loadProgressContainer.classList.add('hidden')
        updateStatus('Model Loaded')
        startBackgroundAnalysis()
        break
      case 'generated':
        isAnalyzing = false
        if (e.data.context && e.data.context.type === 'tap') {
          showBubble(payload, e.data.context.x, e.data.context.y)
        } else {
          descriptionText.textContent = payload
        }
        break
      case 'bubble-generated':
        // Specifically for backward compatibility if any
        isAnalyzing = false
        showBubble(payload.text, payload.x, payload.y)
        break
      case 'error':
        isModelLoading = false;
        isAnalyzing = false;
        if (tapIndicator) {
          tapIndicator.container.remove()
          tapIndicator = null
        }
        if (error) console.error('Worker error:', error);
        
        if (error && error.toLowerCase().includes('unauthorized')) {
          const modelId = modelSelector.value;
          updateStatus('Unauthorized');
          descriptionText.innerHTML = `
            <div style="color: #ffbaba; margin-bottom: 8px;">Access Denied.</div>
            <div style="font-size: 0.9rem; line-height: 1.4;">
              This model on Hugging Face is "gated". <br>
              1. <a href="https://huggingface.co/join" target="_blank" style="color: var(--accent-color); font-weight: bold;">Login/Create HF Account</a> <br>
              2. Accept terms on the <a href="https://huggingface.co/${modelId}" target="_blank" style="color: var(--accent-color); font-weight: bold;">Model Page</a> <br>
            </div>
          `;
        } else {
          updateStatus('Error');
          descriptionText.textContent = `Error: ${error || 'Unknown error'}`;
        }
        
        loadProgressContainer.classList.add('hidden');
        break;
    }
  }
}

function loadModel() {
  if (isModelLoading) return
  isModelLoading = true
  lastDisplayedProgress = 0
  loadingFiles = {}
  const modelId = modelSelector.value
  updateStatus('Loading AI...')
  initWorker()
  worker?.postMessage({ type: 'load', payload: { modelId } })
}

function updateLoadingProgress(payload: any) {
  loadProgressContainer.classList.remove('hidden')
  
  if (payload.status === 'progress' || payload.status === 'done') {
    if (payload.file) {
      loadingFiles[payload.file] = { 
        loaded: payload.loaded || (payload.status === 'done' ? (loadingFiles[payload.file]?.total || 100) : 0), 
        total: payload.total || (loadingFiles[payload.file]?.total || 100) 
      }
    }
    
    let totalLoaded = 0
    let totalExpected = 0
    
    for (const f in loadingFiles) {
      totalLoaded += loadingFiles[f].loaded
      totalExpected += loadingFiles[f].total
    }
    
    if (totalExpected > 0) {
      const actualProgress = (totalLoaded / totalExpected) * 100
      lastDisplayedProgress = Math.max(lastDisplayedProgress, actualProgress)
    }
  }

  const rounded = Math.round(lastDisplayedProgress)
  loadProgressBar.style.width = `${lastDisplayedProgress}%`
  
  let label = `Loading Model... ${rounded}%`
  if (payload.file) {
    const filePath = payload.file
    const fileName = filePath.substring(filePath.lastIndexOf('/') + 1)
    if (fileName) label += ` (${fileName})`
  } else if (payload.status) {
    // Show status if no file name (e.g. "init", "downloading")
    label = `Loading Model... ${payload.status}`
  }
  loadProgressLabel.textContent = label
}

// Capture frame(s)
function captureSingleFrame(crop?: { x: number, y: number, w: number, h: number }): string {
  const context = cropCanvas.getContext('2d')
  if (!context) return ''

  const vWidth = video.videoWidth
  const vHeight = video.videoHeight
  if (!vWidth || !vHeight) return ''
  
  if (crop) {
    cropCanvas.width = crop.w
    cropCanvas.height = crop.h
    context.drawImage(video, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h)
  } else {
    cropCanvas.width = vWidth
    cropCanvas.height = vHeight
    context.drawImage(video, 0, 0, vWidth, vHeight)
  }
  
  return cropCanvas.toDataURL('image/jpeg', 0.8)
}

function updateFrameBuffer() {
  if (video.readyState < 2) return
  const frame = captureSingleFrame()
  if (frame) {
    backgroundFrameBuffer.push(frame)
    if (backgroundFrameBuffer.length > videoFrameCount) {
      backgroundFrameBuffer.shift()
    }
  }
}

function startFrameCapture() {
  if (captureIntervalId) clearInterval(captureIntervalId)
  // Re-calculate capture interval to fill the buffer within one background analysis cycle
  const captureRate = Math.max(100, Math.floor(BACKGROUND_ANALYSIS_INTERVAL / videoFrameCount))
  captureIntervalId = window.setInterval(updateFrameBuffer, captureRate)
}

function captureFrames(): string[] {
  if (backgroundFrameBuffer.length > 0) {
    return [...backgroundFrameBuffer]
  }
  const frame = captureSingleFrame()
  return frame ? [frame] : []
}

let volumeLoopId: number | null = null

// Audio logic
async function startAudio() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    audioContext = new AudioContext({ sampleRate: samplingRate })
    const source = audioContext.createMediaStreamSource(stream)
    const processor = audioContext.createScriptProcessor(4096, 1, 1)
    
    // Analyzer for volume detection
    const analyser = audioContext.createAnalyser()
    analyser.fftSize = 256
    const dataArray = new Uint8Array(analyser.frequencyBinCount)

    const totalSamples = samplingRate * 3 // 3 seconds
    audioBuffer = new Float32Array(totalSamples)
    
    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0)
      for (let i = 0; i < input.length; i++) {
        audioBuffer![audioWriteIdx] = input[i]
        audioWriteIdx = (audioWriteIdx + 1) % totalSamples
      }
    }
    
    function updateVolumeGlow() {
      if (!includeAudio) return
      analyser.getByteFrequencyData(dataArray)
      let sum = 0
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i]
      }
      const average = sum / dataArray.length
      const intensity = Math.pow(average / 128, 2) // Non-linear for better visual pop
      
      toggleAudioBtn.style.boxShadow = `0 0 ${10 + intensity * 40}px rgba(255, 77, 77, ${0.2 + intensity * 0.8})`
      toggleAudioBtn.style.borderColor = `rgba(255, 77, 77, ${0.4 + intensity * 0.6})`
      
      volumeLoopId = requestAnimationFrame(updateVolumeGlow)
    }

    source.connect(analyser)
    source.connect(processor)
    processor.connect(audioContext.destination)
    includeAudio = true
    toggleAudioBtn.classList.add('active-audio')
    toggleAudioBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-mic"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>`
    
    updateVolumeGlow()
  } catch (err) {
    console.error('Audio failed:', err)
  }
}

function stopAudio() {
  includeAudio = false
  if (volumeLoopId) cancelAnimationFrame(volumeLoopId)
  audioContext?.close()
  audioContext = null
  toggleAudioBtn.classList.remove('active-audio')
  toggleAudioBtn.style.boxShadow = ''
  toggleAudioBtn.style.borderColor = ''
  toggleAudioBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-mic-off"><line x1="2" x2="22" y1="2" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2"/><line x1="9" x2="9" y1="19" y2="22"/><line x1="15" x2="15" y1="19" y2="22"/><line x1="12" x2="12" y1="15" y2="18"/></svg>`
}

async function getAudioData() {
  if (!includeAudio || !audioBuffer) return null
  const len = audioBuffer.length
  const data = new Float32Array(len)
  for (let i = 0; i < len; i++) {
    data[i] = audioBuffer[(audioWriteIdx + i) % len]
  }
  return data
}

// Analysis Loop
async function performBackgroundAnalysis() {
  if (!worker || isAnalyzing || isModelLoading) return
  isAnalyzing = true
  
  const frames = captureFrames()
  if (frames.length === 0) {
    isAnalyzing = false
    return
  }
  
  const audio = await getAudioData()
  
  worker.postMessage({
    type: 'generate',
    payload: {
      promptText: `Describe the visible entities (people, objects, environment) concisely. Skip any introductory phrases. Return only the description in ${targetLanguage}.`,
      dataUrls: frames,
      audioData: audio,
      samplingRate
    }
  })
}

function startBackgroundAnalysis() {
  if (backgroundAnalysisId) clearInterval(backgroundAnalysisId)
  backgroundAnalysisId = window.setInterval(performBackgroundAnalysis, BACKGROUND_ANALYSIS_INTERVAL)
  startFrameCapture()
}

// UI Interactions
switchCameraBtn.onclick = () => {
  facingMode = facingMode === 'user' ? 'environment' : 'user'
  initCamera()
}

toggleAudioBtn.onclick = () => {
  if (includeAudio) stopAudio()
  else startAudio()
}

modelSelector.onchange = () => {
  loadModel()
}

// Settings UI
settingsBtn.onclick = () => {
  settingsModal.classList.remove('hidden')
}

closeSettingsBtn.onclick = () => {
  settingsModal.classList.add('hidden')
}

settingsModal.onclick = (e) => {
  if (e.target === settingsModal) {
    settingsModal.classList.add('hidden')
  }
}

frameCountInput.oninput = () => {
  videoFrameCount = parseInt(frameCountInput.value)
  frameCountVal.textContent = videoFrameCount.toString()
  backgroundFrameBuffer = [] // Clear buffer
}

intervalInput.oninput = () => {
  BACKGROUND_ANALYSIS_INTERVAL = parseInt(intervalInput.value)
  intervalVal.textContent = BACKGROUND_ANALYSIS_INTERVAL.toString()
  
  // Restart interval
  if (backgroundAnalysisId) {
    startBackgroundAnalysis()
  }
}

languageSelector.onchange = () => {
  if (languageSelector.value === 'auto') {
    setLanguageFromBrowser()
  } else {
    targetLanguage = languageSelector.value
  }
}

function setLanguageFromBrowser() {
  const lang = navigator.language.toLowerCase()
  if (lang.startsWith('ja')) targetLanguage = 'Japanese'
  else if (lang.startsWith('zh')) targetLanguage = 'Chinese'
  else if (lang.startsWith('es')) targetLanguage = 'Spanish'
  else if (lang.startsWith('fr')) targetLanguage = 'French'
  else if (lang.startsWith('de')) targetLanguage = 'German'
  else targetLanguage = 'English'
}

function autoAdjustPerformance() {
  const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent)
  const cpuCores = navigator.hardwareConcurrency || 4
  // @ts-ignore
  const ram = navigator.deviceMemory || 8

  if (isMobile || cpuCores <= 4 || ram <= 4) {
    videoFrameCount = 4
    BACKGROUND_ANALYSIS_INTERVAL = 8000
    console.log('Low performance mode active:', { videoFrameCount, BACKGROUND_ANALYSIS_INTERVAL })
  } else {
    videoFrameCount = 8
    BACKGROUND_ANALYSIS_INTERVAL = 5000
    console.log('High performance mode active:', { videoFrameCount, BACKGROUND_ANALYSIS_INTERVAL })
  }
  
  // Sync UI if elements exist
  if (frameCountInput) {
    frameCountInput.value = videoFrameCount.toString()
    frameCountVal.textContent = videoFrameCount.toString()
  }
  if (intervalInput) {
    intervalInput.value = BACKGROUND_ANALYSIS_INTERVAL.toString()
    intervalVal.textContent = BACKGROUND_ANALYSIS_INTERVAL.toString()
  }
}

// Tap Interaction
tapSurface.onclick = (e) => {
  const rect = tapSurface.getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top
  
  // Show touch indicator
  const circle = document.createElement('div')
  circle.className = 'touch-circle'
  circle.style.left = `${e.clientX}px`
  circle.style.top = `${e.clientY}px`
  document.body.appendChild(circle)
  setTimeout(() => circle.remove(), 800)

  // Perform localized analysis
  performTapAnalysis(x, y, rect.width, rect.height, e.clientX, e.clientY)
}

// Tap State & Visuals
let tapIndicator: { container: HTMLDivElement, circle: SVGCircleElement } | null = null
let isCapturingTap = false

function createTapIndicator(x: number, y: number) {
  const container = document.createElement('div')
  container.className = 'tap-indicator-container'
  container.style.left = `${x}px`
  container.style.top = `${y}px`

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '100')
  svg.setAttribute('height', '100')
  svg.setAttribute('class', 'tap-progress-ring')

  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  const radius = 40
  const circumference = 2 * Math.PI * radius
  circle.setAttribute('cx', '50')
  circle.setAttribute('cy', '50')
  circle.setAttribute('r', `${radius}`)
  circle.style.strokeDasharray = `${circumference}`
  circle.style.strokeDashoffset = `${circumference}`
  
  svg.appendChild(circle)
  container.appendChild(svg)
  document.body.appendChild(container)
  
  return { container, circle, circumference }
}

async function performTapAnalysis(clickX: number, clickY: number, containerW: number, containerH: number, screenX: number, screenY: number) {
  if (!worker || isModelLoading) return

  // Prevent background analysis from interfering
  isAnalyzing = true

  // Cancel any existing capture
  if (tapIndicator) {
    tapIndicator.container.remove()
    isCapturingTap = false
  }

  const indicator = createTapIndicator(screenX, screenY)
  tapIndicator = indicator
  isCapturingTap = true

  // Calculate crop area
  const cropSize = Math.min(containerW, containerH) * 0.4
  const startX = Math.max(0, clickX - cropSize / 2)
  const startY = Math.max(0, clickY - cropSize / 2)
  const scaleX = video.videoWidth / containerW
  const scaleY = video.videoHeight / containerH
  const vCropX = startX * scaleX
  const vCropY = startY * scaleY
  const vCropW = cropSize * scaleX
  const vCropH = cropSize * scaleY

  const frames: string[] = []
  const context = tapCanvas.getContext('2d')
  if (!context) {
    isAnalyzing = false
    return
  }
  
  tapCanvas.width = vCropW
  tapCanvas.height = vCropH
  
  const burstCount = 5
  const interval = 300
  
  // Capturing Phase
  try {
    for (let i = 0; i < burstCount; i++) {
      if (!isCapturingTap) throw new Error('Capture Canceled')
      
      // Update progress ring
      const progress = (i + 1) / burstCount
      indicator.circle.style.strokeDashoffset = `${indicator.circumference * (1 - progress)}`
      
      context.drawImage(video, vCropX, vCropY, vCropW, vCropH, 0, 0, vCropW, vCropH)
      frames.push(tapCanvas.toDataURL('image/jpeg', 0.8))
      
      await new Promise(r => setTimeout(r, interval))
    }
  } catch (err) {
    console.warn(err)
    indicator.container.remove()
    isAnalyzing = false
    return
  }

  // Done Capturing Phase
  isCapturingTap = false
  indicator.circle.style.stroke = 'rgba(255, 255, 255, 0.2)' // Dim the ring
  
  // Show Completion checkmark briefly or move to thinking
  const doneEl = document.createElement('div')
  doneEl.className = 'tap-completion'
  doneEl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
  indicator.container.appendChild(doneEl)
  
  await new Promise(r => setTimeout(r, 600))
  doneEl.remove()

  // Thinking Phase
  const thinkingEl = document.createElement('div')
  thinkingEl.className = 'thinking-indicator'
  thinkingEl.innerHTML = `<div class="thinking-dot"></div><div class="thinking-dot"></div><div class="thinking-dot"></div>`
  indicator.container.appendChild(thinkingEl)

  // Request specific analysis
  worker.postMessage({
    type: 'generate',
    payload: {
      promptText: `Identify the object or feature at the specified position. Return only the brief description in ${targetLanguage} without any preamble.`,
      dataUrls: frames,
      audioData: await getAudioData(),
      samplingRate,
      context: { type: 'tap', x: screenX, y: screenY }
    }
  })
}

// Result of Tap Analysis is handled by common onmessage in initWorker()


function showBubble(text: string, x: number, y: number) {
  // Cleanup previous tap indicator if exists
  if (tapIndicator) {
     tapIndicator.container.remove()
     tapIndicator = null
  }

  const existing = document.querySelectorAll('.result-bubble, .bubble-connector-svg')
  existing.forEach(el => el.remove())

  // Target position for bubble
  const margin = 80
  const bubbleY = Math.max(margin, y - 100)
  const bubbleX = Math.max(margin, Math.min(window.innerWidth - margin, x))

  // Create Bubble
  const bubble = document.createElement('div')
  bubble.className = 'result-bubble'
  bubble.style.left = `${bubbleX}px`
  bubble.style.top = `${bubbleY}px`
  bubble.style.transform = 'translate(-50%, -100%)' // Center horizontally, place above target Y
  bubble.style.pointerEvents = 'auto' // Ensure it catches clicks
  
  // Stop click propagation to tapSurface
  bubble.onclick = (e) => e.stopPropagation()
  
  // Header with Close Button
  const header = document.createElement('div')
  header.style.display = 'flex'
  header.style.justifyContent = 'flex-end'
  header.style.marginBottom = '4px'
  
  const closeBtn = document.createElement('button')
  closeBtn.className = 'bubble-close-btn'
  closeBtn.innerHTML = '&times;'
  closeBtn.onclick = (e) => {
    e.stopPropagation()
    bubble.style.opacity = '0'
    bubble.style.transform = 'translate(-50%, -100%) scale(0.8)'
    setTimeout(() => bubble.remove(), 400)
  }
  
  header.appendChild(closeBtn)
  bubble.appendChild(header)
  
  const content = document.createElement('div')
  content.innerHTML = `<p style="font-size: 0.85rem; line-height: 1.4; margin: 0;">${text}</p>`
  bubble.appendChild(content)
  
  bubbleContainer.appendChild(bubble)
}

// Initial Load
window.onload = async () => {
  if (isInitialized) return
  isInitialized = true

  // Loop guard for mobile/pc stabilization
  const now = Date.now()
  const lastLoad = parseInt(sessionStorage.getItem('last_load_time') || '0')
  const loadCount = parseInt(sessionStorage.getItem('load_count') || '0')
  
  if (now - lastLoad < 2000 && loadCount > 3) {
    console.error('Reload loop detected. Stopping initialization.')
    updateStatus('Error: Reload Loop')
    descriptionText.textContent = 'Critical Error: The page is reloading too frequently. Please try clearing your cache or opening in a new tab.'
    return
  }
  
  sessionStorage.setItem('last_load_time', now.toString())
  sessionStorage.setItem('load_count', (now - lastLoad < 5000 ? loadCount + 1 : 1).toString())
  
  autoAdjustPerformance()
  setLanguageFromBrowser()
  
  // Sequence them to avoid resource peaks on mobile
  await initCamera()
  loadModel()

  // Only register Service Worker in production/secure environments, not on localhost to avoid HMR loops
  const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  if (!isLocalhost) {
    const updateSW = registerSW({
      onNeedRefresh() {
        if (confirm('New AI engine update available. Reload now?')) {
          updateSW()
        }
      },
      onOfflineReady() {
        console.log('App is ready to work offline.')
      }
    })
  } else {
    console.log('Localhost detected: Skipping Service Worker registration.')
  }
}
