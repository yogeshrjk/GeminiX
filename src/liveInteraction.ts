export interface LiveInteractionMessage {
  readonly interactionStatus?: string;
  readonly interaction_status?: string;
  readonly serverContent?: {
    readonly interactionStatus?: string;
    readonly interaction_status?: string;
    readonly turnComplete?: boolean;
    readonly interrupted?: boolean;
  };
  readonly toolCall?: { readonly functionCalls?: readonly unknown[] };
}

export function interactionStatus(message: LiveInteractionMessage): string | undefined {
  return message.interactionStatus ?? message.interaction_status ??
    message.serverContent?.interactionStatus ?? message.serverContent?.interaction_status;
}

/** Thinking can finish a spoken utterance while its tools are still running. */
export function isInteractionComplete(message: LiveInteractionMessage, model?: string): boolean {
  const status = interactionStatus(message);
  if (status === "IN_PROGRESS") return false;
  if (status === "IDLE") return true;
  if (model === "gemini-3.8-live-extended-thinking") return false;
  return Boolean(message.serverContent?.turnComplete) &&
    !message.toolCall?.functionCalls?.length;
}
