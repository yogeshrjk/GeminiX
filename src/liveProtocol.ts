export interface LiveFunctionResponse {
  readonly id: string;
  readonly name: string;
  readonly response: Readonly<Record<string, unknown>>;
}

export interface LiveFunctionCall {
  readonly id: string;
  readonly name: string;
  readonly args?: Readonly<Record<string, unknown>>;
}

/** Owns call IDs for one socket: cancelled and completed calls cannot reply. */
export class LiveToolCalls {
  private readonly pending = new Map<string, string>();
  private readonly seen = new Set<string>();

  public accept(calls: readonly unknown[]): readonly LiveFunctionCall[] {
    return calls.filter((value): value is LiveFunctionCall => {
      if (typeof value !== "object" || value === null) return false;
      const call = value as Partial<LiveFunctionCall>;
      if (typeof call.id !== "string" || !call.id.trim() || typeof call.name !== "string" || !call.name.trim() || this.seen.has(call.id)) return false;
      this.seen.add(call.id);
      this.pending.set(call.id, call.name);
      return true;
    });
  }

  public has(id: string): boolean { return this.pending.has(id); }

  public complete(responses: readonly LiveFunctionResponse[]): readonly LiveFunctionResponse[] {
    return responses.filter((response) => {
      if (this.pending.get(response.id) !== response.name) return false;
      this.pending.delete(response.id);
      return true;
    });
  }

  public cancel(ids?: readonly string[]): void {
    if (ids) ids.forEach((id) => this.pending.delete(id));
    else this.pending.clear();
  }

  public reset(): void { this.pending.clear(); this.seen.clear(); }
}

export interface LiveToolResponsePayload {
  readonly toolResponse: {
    readonly functionResponses: readonly LiveFunctionResponse[];
  };
}

export function createToolResponsePayload(
  functionResponses: readonly LiveFunctionResponse[]
): LiveToolResponsePayload {
  return {
    toolResponse: {
      functionResponses
    }
  };
}

export function isLiveFunctionResponse(
  value: unknown
): value is LiveFunctionResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Readonly<Record<string, unknown>>;
  return (
    typeof candidate["id"] === "string" &&
    Boolean(candidate["id"].trim()) &&
    typeof candidate["name"] === "string" &&
    Boolean(candidate["name"].trim()) &&
    typeof candidate["response"] === "object" &&
    candidate["response"] !== null &&
    !Array.isArray(candidate["response"])
  );
}
