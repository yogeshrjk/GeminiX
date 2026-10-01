import { buildSystemInstruction } from "./prompts.js";
import type { Preferences } from "./types.js";

export function createLiveSetupMessage(preferences: Preferences) {
  const selectedModel = preferences.liveModel || "gemini-3.8-live";
  const isExtendedThinking =
    selectedModel === "gemini-3.8-live-extended-thinking";

  const generationConfig: Record<string, unknown> = {
    responseModalities: ["AUDIO"],
    temperature: 0.3,
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: preferences.voice
        }
      }
    }
  };

  if (isExtendedThinking) {
    const level = (preferences.thinkingLevel === "minimal" ? "low" : preferences.thinkingLevel ?? "high").toUpperCase();
    generationConfig.thinkingConfig = {
      thinkingLevel:
        level === "LOW" ||
        level === "MEDIUM" ||
        level === "HIGH"
          ? level
          : "HIGH"
    };
  }

  return {
    setup: {
      model: `models/${selectedModel}`,
      generationConfig,
      outputAudioTranscription: {},
      realtimeInputConfig: {
        activityHandling: preferences.autoInterrupt
          ? "START_OF_ACTIVITY_INTERRUPTS"
          : "NO_INTERRUPTION"
      },
      systemInstruction: {
        parts: [{ text: buildSystemInstruction(preferences) }]
      },
      tools: [
        {
          functionDeclarations: [
            {
              name: "search_workspace",
              description:
                "Search the currently open VS Code workspace for files, symbols, definitions, imports, routes, components, and usages. Use this whenever the supplied context does not contain enough code to answer. The result contains real code snippets and paths.",
              parameters: {
                type: "OBJECT",
                properties: {
                  query: {
                    type: "STRING",
                    description:
                      "A precise filename, symbol, import path, or code-search query."
                  }
                },
                required: ["query"]
              }
            },
            {
              name: "read_workspace_file",
              description:
                "Read a specific workspace file returned by search_workspace. Call this after finding a path when you need more code. Large files can be read in line ranges.",
              parameters: {
                type: "OBJECT",
                properties: {
                  file_path: {
                    type: "STRING",
                    description:
                      "Workspace-relative file path, such as src/components/TemplateBuilder.jsx."
                  },
                  start_line: {
                    type: "INTEGER",
                    description:
                      "Optional 1-based first line. Defaults to line 1."
                  },
                  end_line: {
                    type: "INTEGER",
                    description:
                      "Optional 1-based last line. Defaults to a bounded section."
                  }
                },
                required: ["file_path"]
              }
            },
            {
              name: "fetch_url",
              description:
                "Fetch a web page (GitHub repository, README, article, documentation page, blog post, etc.) shared by the user and return its readable text content. Use this whenever the user shares a link or asks for details about a specific URL. The result contains the page title and extracted text.",
              parameters: {
                type: "OBJECT",
                properties: {
                  url: {
                    type: "STRING",
                    description:
                      "The absolute http(s) URL to fetch."
                  }
                },
                required: ["url"]
              }
            },
            {
              name: "search_web",
              description:
                "Search the web or a specific source for a topic and return matching titles and URLs. Choose the source that best fits the question: web (default general search for apps, websites, companies, tools, and documentation); github for GitHub users, profiles, repositories, and projects; registry for the latest version of Node.js, npm packages, or Python packages; stackoverflow for programming questions and errors; mdn for web platform documentation; hackernews for tech news and discussions; wikipedia for general technical concepts; crates for Rust crates; rubygems for Ruby gems; and go for Go modules. If needed, try one focused alternative query. Use fetch_url when full page details are required.",
              parameters: {
                type: "OBJECT",
                properties: {
                  query: {
                    type: "STRING",
                    description:
                      "A concise search phrase, app name, package name, username, or topic."
                  },
                  source: {
                    type: "STRING",
                    description:
                      "The source to search: web (general web search), github, registry, stackoverflow, mdn, hackernews, wikipedia, crates, rubygems, or go. Defaults to web."
                  }
                },
                required: ["query"]
              }
            },
            {
              name: "render_markdown",
              description:
                "Display the requested code, Markdown tables, JSON, source links, or detailed formatted explanation in the chat panel. Send each section once with complete content; use fenced blocks for code. This tool displays content; it does not execute code or change files.",
              parameters: {
                type: "OBJECT",
                properties: {
                  markdown: {
                    type: "STRING",
                    description:
                      "The complete Markdown content including fenced code blocks (e.g. ```python), headings, explanations, or JSON to display in the chat panel."
                  }
                },
                required: ["markdown"]
              }
            }
          ].map((declaration) => ({
            ...declaration,
            // Extended Thinking requires asynchronous tools; 3.1 is sequential.
            ...(isExtendedThinking ? { behavior: "NON_BLOCKING" } :
              selectedModel === "gemini-3.8-live" ? { behavior: "BLOCKING" } : {})
          }))
        }
      ]
    }
  };
}
