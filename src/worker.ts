import {
  env,
  AutoProcessor,
  Gemma4ForConditionalGeneration,
  RawImage,
  TextStreamer
} from '@huggingface/transformers'

env.allowLocalModels = false

let processor: any | null = null
let model: any | null = null

self.onmessage = async (e: MessageEvent) => {
  const { type, payload } = e.data

  if (type === 'load') {
    try {
      const { modelId } = payload
      self.postMessage({ type: 'status', payload: `Loading processor...` })
      processor = (await AutoProcessor.from_pretrained(modelId)) as any
      self.postMessage({ type: 'status', payload: `Loading model...` })
      model = (await Gemma4ForConditionalGeneration.from_pretrained(modelId, {
        dtype: 'q4f16',
        device: 'webgpu',
        progress_callback: (info: any) => {
          self.postMessage({ type: 'progress', payload: info })
        }
      })) as any
      self.postMessage({ type: 'loaded' })
    } catch (error: any) {
      console.error(error)
      const message = error.message || String(error)
      self.postMessage({ type: 'error', error: message })
    }
  } else if (type === 'generate') {
    let images: any[] = []
    try {
      if (!processor || !model) {
        throw new Error('Model or processor not loaded')
      }
      const { promptText, images: inputImages, dataUrls, audioData, samplingRate } = payload
      
      // Handle both ImageBitmap (new) and dataUrls (fallback)
      if (inputImages && inputImages.length > 0) {
        images = await Promise.all(inputImages.map(async (img: ImageBitmap) => {
          const canvas = new OffscreenCanvas(img.width, img.height);
          const ctx = canvas.getContext('2d');
          ctx?.drawImage(img, 0, 0);
          const imageData = ctx?.getImageData(0, 0, img.width, img.height);
          img.close(); // Important: Close bitmap in worker as well
          if (!imageData) throw new Error('Failed to get image data');
          // @ts-ignore
          return new RawImage(imageData.data, img.width, img.height, 4);
        }));
      } else if (dataUrls) {
        images = await Promise.all(dataUrls.map((url: string) => RawImage.fromURL(url)))
      }

      const content: Array<{ type: string; text?: string }> = []

      if (images.length > 0) {
        for (let i = 0; i < images.length; i++) {
          content.push({ type: 'image' })
        }
      }

      if (audioData) {
        content.push({ type: 'audio' })
      }

      content.push({ type: 'text', text: promptText })

      const messages = [
        {
          role: 'user',
          content
        }
      ]

      let prompt = (await (
        processor as any
      ).apply_chat_template(messages, {
        add_generation_prompt: true,
        tokenize: false
      })) as string

      const imageTag = (processor as any).image_token || '<image>'
      const audioTag = (processor as any).audio_token || '<audio>'
      const videoTag = '<video>'

      const hasImageToken =
        prompt.includes(imageTag) || prompt.includes('<boi>') || prompt.includes('[IMAGE]')
      const hasAudioToken =
        prompt.includes(audioTag) || prompt.includes('<boa>') || prompt.includes('[AUDIO]')
      const hasVideoToken = prompt.includes(videoTag) || prompt.includes('[VIDEO]')

      if (images.length > 0 && !hasImageToken && !hasVideoToken) {
        const placeholders = imageTag.repeat(images.length)
        prompt = prompt.replace(/(<start_of_turn>user\s*)/, `$1\n${placeholders}\n`)
      }

      if (audioData && !hasAudioToken) {
        if (prompt.includes(imageTag)) {
          prompt = prompt.replace(imageTag, `${imageTag}${audioTag}`)
        } else {
          prompt = prompt.replace(/(<start_of_turn>user\s*)/, `$1\n${audioTag}\n`)
        }
      }

      const inputs = await (
        processor as any
      )(prompt, images, audioData, {
        sampling_rate: samplingRate
      })

      const streamer = new TextStreamer(processor.tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (text: string) => {
          self.postMessage({ type: 'chunk', payload: text })
        }
      })

      const outputs = (await (
        model as any
      ).generate({
        ...inputs,
        max_new_tokens: 128, // Reduced for mobile stability
        do_sample: false,
        streamer
      }))

      const decoded = processor.batch_decode(
        // @ts-ignore
        outputs.slice(null, [inputs.input_ids.dims.at(-1), null]),
        { skip_special_tokens: true }
      )
      self.postMessage({ type: 'generated', payload: decoded[0], context: payload.context })
      
      // Cleanup tensors if possible
      if (inputs.input_ids) inputs.input_ids.dispose?.();
      if (outputs) outputs.dispose?.();

    } catch (error: any) {
      console.error(error)
      const message = error.message || String(error)
      self.postMessage({ type: 'error', error: message })
    } finally {
      images = []; // Clear references
    }
  }
}
