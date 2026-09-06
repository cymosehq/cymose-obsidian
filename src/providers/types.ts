export type Message = { role: "system" | "user" | "assistant"; content: string };

export type ModelOptions = {
	model: string;
	temperature: number;
	maxTokens: number;
};

/**
 * A model provider.
 *
 * Chat goes to whichever adapter settings picked. Cymose is not a provider.
 * A second vendor is a new file behind ModelAdapter, not a change above it.
 */
export interface ModelAdapter {
	readonly id: string;
	/**
	 * Streams the answer in chunks as they arrive.
	 *
	 * `signal` aborts the request when the user presses Stop. It surfaces as a
	 * DOMException named "AbortError" out of the generator — the caller keeps
	 * whatever chunks it already had rather than treating it as a failure.
	 */
	chat(messages: Message[], options: ModelOptions, signal?: AbortSignal): AsyncGenerator<string>;
}

/** Carries the provider's status so a caller can tell "slow down" from "wrong key". */
export class ProviderError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
		this.name = "ProviderError";
	}

	/** A human sentence, since this ends up in a Notice. */
	get friendly(): string {
		switch (this.status) {
			case 401:
				return "That API key was rejected. Check it in Cymose settings.";
			case 402:
				return "Your provider account is out of credit.";
			case 429:
				return "Rate limited by the provider. Wait a moment, or pick another model.";
			default:
				return this.status >= 500
					? `The provider failed (${this.status}). Trying again usually works.`
					: this.message;
		}
	}
}
