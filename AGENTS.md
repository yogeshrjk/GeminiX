# GeminiX Architecture, Models & Agent Guidelines

## 1. Gemini Models & API Policy

### Retired / Legacy Models (DO NOT USE)

The following legacy models are retired and MUST NOT be used:

- `gemini-2.5-flash`
- `gemini-2.5-flash-lite`
- `gemini-2.0-flash`
- `gemini-1.5-flash`

### Supported Models

- **Live Session WebSocket (`BidiGenerateContent`)**:
  - `gemini-3.1-flash-live-preview` (Conversational Multimodal Voice & Tools)
    - Endpoint: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`
  - `gemini-3.5-transcribe-live` (Real-Time Live Speech-to-Text Transcription)
    - Endpoint: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent`
- **Document & Image OCR / REST Extraction & Transcript Reconciliation**:
  - `gemini-3.5-flash-lite` (Primary)
  - `gemini-3.1-flash-lite` (Fallback)

---

## 2. File & Image Handling Architecture

### Spoken Speech-to-Text & Transcript Reconciliation

- **Real-Time Live Transcription**: Spoken audio is transcribed live by `gemini-3.5-transcribe-live` via WebSocket streaming with `responseModalities: ["TEXT"]`.
- **Automatic Transcript Reconciliation**: On voice turn completion, if any phonetic or cross-language ASR artifacts occurred, the transcript is reconciled via `gemini-3.5-flash-lite` (fallback `gemini-3.1-flash-lite`) using the assistant's grounded response and user's `preferredLanguage` to ensure clean, accurate text in the UI.

### Documents (.pdf, .xlsx, .docx, .pptx, etc.)

- **REST Extraction Only**: Documents are processed exclusively through the REST `generateContent` endpoint using `gemini-3.5-flash-lite` / `gemini-3.1-flash-lite`.
- Extracted text is injected into the text prompt context before sending the turn.
- Automatic retry on `503`, `500`, and `429` status codes.

### Images (.png, .jpg, .jpeg, .webp)

- **Google Vision OCR & Visual Analysis**: Images are processed through the REST `generateContent` endpoint using `gemini-3.5-flash-lite` / `gemini-3.1-flash-lite` to extract text, code, diagrams, and visual structure into Markdown context before sending the turn.
- Automatic retry on `503`, `500`, and `429` status codes.
- Local fallback preview and raster context are preserved if Vision extraction is unavailable.

---

## 3. Webview & UI Constraints

1. **Send Button vs Stop Button**:
   - During processing, the input area replaces the send icon with an outline stop square (`lucideIconSvg("square", 14)`).
   - Mic is auto-muted during processing to avoid accidental audio interruptions.
   - When files or images are attached without typed text, the send button remains enabled so the user can send attachment-only queries.
2. **User Message Bubble Display**:
   - When an image or file is sent without accompanying text, only the image thumbnail or file chip is displayed in the user message bubble—no synthetic text like _"Please examine the attached context..."_ is shown to the user.
3. **Empty Chat Messages**:
   - `chatSchema.ts` must allow attachment-only messages (empty `spokenText` / `visualText`) without throwing _"A stored chat message has no content."_
4. **Code & Web Links**:
   - Code symbols (e.g. `this.secrets.get`) are styled as inline code and must NEVER be treated as external web links.
   - External links must be validated valid web URLs with valid TLDs before rendering as external links.
   - File references (e.g. `README.md`, `src/index.ts`) must render as internal clickable links that open the file in the VS Code editor.
