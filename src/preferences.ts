import * as vscode from "vscode";
import {
  BEHAVIORS,
  GEMINI_VOICES,
  LIVE_MODELS,
  PREFERRED_LANGUAGES,
  THINKING_LEVELS,
  type Preferences
} from "./types.js";

function isOneOf<T extends string>(
  value: string | undefined,
  allowed: readonly T[]
): value is T {
  return value !== undefined && allowed.some((item) => item === value);
}

export function readPreferences(): Preferences {
  const configuration = vscode.workspace.getConfiguration("liveline");
  const voiceValue = configuration.get<string>("voice");
  const languageValue = configuration.get<string>("preferredLanguage");
  const behaviorValue = configuration.get<string>("behavior");
  const liveModelValue = configuration.get<string>("liveModel");
  const thinkingLevelValue = configuration.get<string>("thinkingLevel");

  return {
    voice: isOneOf(voiceValue, GEMINI_VOICES) ? voiceValue : "Kore",
    preferredLanguage: isOneOf(languageValue, PREFERRED_LANGUAGES)
      ? languageValue
      : "English",
    autoInterrupt: configuration.get<boolean>("autoInterrupt", true),
    behavior: isOneOf(behaviorValue, BEHAVIORS)
      ? behaviorValue
      : "professional",
    liveModel: isOneOf(liveModelValue, LIVE_MODELS)
      ? liveModelValue
      : "gemini-3.8-live",
    thinkingLevel: isOneOf(thinkingLevelValue, THINKING_LEVELS)
      ? thinkingLevelValue
      : "high"
  };
}

export async function savePreferences(
  preferences: Preferences
): Promise<Preferences> {
  if (
    !isOneOf(preferences.voice, GEMINI_VOICES) ||
    !isOneOf(preferences.preferredLanguage, PREFERRED_LANGUAGES) ||
    !isOneOf(preferences.behavior, BEHAVIORS) ||
    (preferences.liveModel !== undefined &&
      !isOneOf(preferences.liveModel, LIVE_MODELS)) ||
    (preferences.thinkingLevel !== undefined &&
      !isOneOf(preferences.thinkingLevel, THINKING_LEVELS)) ||
    typeof preferences.autoInterrupt !== "boolean"
  ) {
    throw new Error("One or more GeminiX settings are invalid.");
  }

  const configuration = vscode.workspace.getConfiguration("liveline");
  await Promise.all([
    configuration.update(
      "voice",
      preferences.voice,
      vscode.ConfigurationTarget.Global
    ),
    configuration.update(
      "preferredLanguage",
      preferences.preferredLanguage,
      vscode.ConfigurationTarget.Global
    ),
    configuration.update(
      "autoInterrupt",
      preferences.autoInterrupt,
      vscode.ConfigurationTarget.Global
    ),
    configuration.update(
      "behavior",
      preferences.behavior,
      vscode.ConfigurationTarget.Global
    ),
    configuration.update(
      "liveModel",
      preferences.liveModel ?? "gemini-3.8-live",
      vscode.ConfigurationTarget.Global
    ),
    configuration.update(
      "thinkingLevel",
      preferences.thinkingLevel ?? "high",
      vscode.ConfigurationTarget.Global
    )
  ]);

  return readPreferences();
}
