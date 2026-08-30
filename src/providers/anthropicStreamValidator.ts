import { HttpError } from "../utils/httpErrors.js";

export interface AnthropicStreamValidationResult {
  completed: boolean;
  terminalEvent: string | null;
}

export class AnthropicStreamValidator {
  private buffer = "";
  private messageStarted = false;
  private messageStopped = false;
  private terminalEvent: string | null = null;

  public observe(raw: string): void {
    this.buffer += raw;

    while (true) {
      const lfBoundary = this.buffer.indexOf("\n\n");
      const crlfBoundary = this.buffer.indexOf("\r\n\r\n");
      const boundaries = [lfBoundary, crlfBoundary].filter((value) => value >= 0);
      if (boundaries.length === 0) {
        return;
      }

      const boundary = Math.min(...boundaries);
      const separatorLength = boundary === crlfBoundary ? 4 : 2;
      const segment = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + separatorLength);
      this.observeSegment(segment);
    }
  }

  public result(): AnthropicStreamValidationResult {
    return {
      completed: this.messageStarted && this.messageStopped,
      terminalEvent: this.terminalEvent
    };
  }

  public finish(): AnthropicStreamValidationResult {
    if (!this.messageStarted) {
      throw new HttpError(
        502,
        "provider_incomplete_stream",
        "Anthropic stream ended without message_start",
        true
      );
    }
    if (!this.messageStopped) {
      throw new HttpError(
        502,
        "provider_incomplete_stream",
        "Anthropic stream ended without message_stop",
        true
      );
    }
    return this.result();
  }

  private observeSegment(segment: string): void {
    let eventName: string | null = null;
    const dataLines: string[] = [];

    for (const line of segment.split(/\r?\n/)) {
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }

    let payloadType: string | null = null;
    if (dataLines.length > 0) {
      try {
        const payload = JSON.parse(dataLines.join("\n")) as { type?: unknown };
        payloadType = typeof payload.type === "string" ? payload.type : null;
      } catch {
        payloadType = null;
      }
    }

    const observedEvent = payloadType ?? eventName;
    if (!observedEvent) {
      return;
    }

    this.terminalEvent = observedEvent;
    if (observedEvent === "message_start") {
      this.messageStarted = true;
    }
    if (observedEvent === "message_stop") {
      this.messageStopped = true;
    }
  }
}
