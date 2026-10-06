export interface LLMClient {
    complete(prompt: string, signal: AbortSignal): Promise<string>;
}
