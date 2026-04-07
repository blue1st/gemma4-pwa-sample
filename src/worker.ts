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
        const processed = await Promise.all(inputImages.map(async (img: ImageBitmap) => {
          try {
            const w = img.width;
            const h = img.height;
            if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
              console.error('Worker: Invalid ImageBitmap dimensions:', { w, h });
              img.close();
              return null;
            }

            const canvas = new OffscreenCanvas(w, h);
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('Worker failed to get 2d context');
            
            ctx.drawImage(img, 0, 0);
            const imageData = ctx.getImageData(0, 0, w, h);
            img.close(); 

            // Convert to Uint8Array as some RawImage versions prefer it over Uint8ClampedArray
            const data = new Uint8Array(imageData.data.buffer);
            
            try {
               // @ts-ignore
               return new RawImage(data, w, h, 4);
            } catch (rawError: any) {
               console.error('Worker: RawImage constructor failed:', { message: rawError.message, w, h });
               throw rawError;
            }
          } catch (e: any) {
            console.error('Worker: Image processing failed:', e);
            img.close();
            // Propagate the specific browser error so it can be seen in the UI
            throw e;
          }
        }));
        images = processed.filter(img => img !== null);
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

      let inputs: any = null;
      let outputs: any = null;
      try {
        inputs = await (
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

        outputs = (await (
          model as any
        ).generate({
          ...inputs,
          max_new_tokens: 64, // Further reduced for mobile stability
          do_sample: false,
          streamer
        }))

        const decoded = processor.batch_decode(
          // @ts-ignore
          outputs.slice(null, [inputs.input_ids.dims.at(-1), null]),
          { skip_special_tokens: true }
        )
        self.postMessage({ type: 'generated', payload: decoded[0], context: payload.context })
      } finally {
        // Essential: Always cleanup tensors to prevent OOM/GPU crashes on subsequent runs
        if (inputs) {
          Object.values(inputs).forEach((tensor: any) => {
            if (tensor && typeof tensor.dispose === 'function') {
              tensor.dispose();
            }
          });
        }
        if (outputs && typeof outputs.dispose === 'function') {
          if (typeof outputs.dispose === 'function') {
            outputs.dispose();
          }
        }
      }

    } catch (error: any) {
      console.error(error)
      const message = error.message || String(error)
      self.postMessage({ type: 'error', error: message })
    } finally {
      images = []; // Clear references
    }
  }
}
