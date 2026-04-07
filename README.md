# Gemma4 On-Device Vision

## Overview
Based on the `gemma4-sandbox` structure, we have created a Progressive Web App (PWA) that performs real-time video and audio analysis using `Transformers.js` v4 and `Gemma 4` models directly in the browser. This project showcases the capabilities of running advanced Vision-Language Models (VLM) entirely on-device via WebGPU.

## Key Features
- **PWA Integration**: Fully offline-capable (after model download) with service worker and manifest.
- **Real-time Camera**: Supports front/rear camera switching with a premium full-screen interface.
- **Gemma 4 Models**: Uses `E2B` (Lite) and `E4B` (Smart) quantized ONNX models via WebGPU.
- **Multimodal Analysis**: Default loop analyzes the entire screen and audio to provide 1-2 sentence descriptions in Japanese.
- **Tap-to-Analyze**: 
  - Tapping the screen crops the surrounding area (localized).
  - Captures a 3-frame burst for "video" context of the tapped area.
  - Displays the result in a floating speech bubble (glassmorphism style).
- **Premium Design**: Dark mode, glassmorphism UI, smooth animations, and responsive layout.

## Project Structure
- `index.html`: Modern UI layout with camera background and translucent controls.
- `src/style.css`: Premium styling with animations and glass effects.
- `src/main.ts`: Main application logic (Camera, Audio, UI, Tap interaction).
- `src/worker.ts`: Web Worker for non-blocking ML inference using Transformers.js.
- `vite.config.ts`: Vite configuration with PWA and WebGPU COOP/COEP headers.
- `src/vite-env.d.ts`: TypeScript environment for PWA virtual modules.

## How to Run
1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the development server:
   ```bash
   npm run dev
   ```
3. Access the app via `localhost` (WebGPU requires HTTPS or Localhost).

## Tech Stack
- **Framework**: Vite + Vanilla TypeScript
- **Machine Learning**: `@huggingface/transformers` v4.0.1+
- **PWA**: `vite-plugin-pwa`
- **Styling**: Vanilla CSS (Custom Glassmorphism)
