const RECONCILIATION_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite"
] as const;

export interface ReconcileTranscriptOptions {
  readonly rawTranscript: string;
  readonly assistantResponse: string;
  readonly preferredLanguage: string;
  readonly apiKey: string;
}

export async function reconcileSpokenTranscript(
  options: ReconcileTranscriptOptions
): Promise<string | undefined> {
  const raw = options.rawTranscript.trim();
  const responseText = options.assistantResponse.trim();

  if (!raw || !responseText || !options.apiKey) {
    return undefined;
  }

  const prompt = [
    "You are an expert multilingual speech-to-text transcript correction and reconciliation engine for a VS Code programming assistant.",
    "",
    "Context:",
    `- User's Configured Preferred Language: "${options.preferredLanguage}"`,
    `- Raw Automatic Speech Recognition (ASR) Transcript: "${raw}"`,
    `- Assistant's Response (the assistant heard the user's raw microphone audio directly and understood their real spoken intent): "${responseText.slice(0, 1000)}"`,
    "",
    "Task:",
    "Analyze the Raw ASR Transcript in light of the Assistant's Response.",
    "1. If the Raw ASR Transcript was transcribed in the wrong language (e.g. Spanish words for Hindi speech, broken phonetic English for multilingual speech), or contains garbled symbols or phonetically corrupted words, reconstruct the clean, intended spoken question in the user's intended language.",
    "2. If the Raw ASR Transcript is already clear, accurate, and faithful to what the user asked, return the raw transcript as-is.",
    "",
    "Rules:",
    "- Return ONLY the exact clean spoken sentence. Never output explanations, labels, prefixes, or markdown code blocks.",
    "- Preserve technical terms, file paths, commands, code identifiers, and framework names in their correct spelling."
  ].join("\n");

  for (const model of RECONCILIATION_MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(options.apiKey)}`;
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [{ text: prompt }]
              }
            ],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 256
            }
          })
        });

        if (!response.ok) {
          continue;
        }

        const data = (await response.json()) as {
          candidates?: Array<{
            content?: {
              parts?: Array<{ text?: string }>;
            };
          }>;
        };

        const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (resultText) {
          const cleaned = resultText.replace(/^["'“”]+|["'“”]+$/g, "").trim();
          if (cleaned && cleaned !== raw) {
            return cleaned;
          }
        }
        return undefined;
      } catch {
        // Proceed to next attempt or fallback model
      }
    }
  }

  return undefined;
}
