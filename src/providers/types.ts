export type Message = { role: "system" | "user" | "assistant"; content: string };

export type ModelOptions = {
	model: string;
	temperature: number;
	maxTokens: number;
};

/**
 * A model provider.
 *
 * There is one implementation today (OpenRouter), and the interface exists
 * anyway because the second one is the point: the product promise is that a
 * rate limit at one vendor doesn't stop your afternoon. Anything provider-
 * specific — auth header, request shape, stream dialect — stops here, so the
 * conversation layer never learns which vendor it is talking to.
 */
export interface ModelAdapter {
	readonly id: string;
	/** Streams the answer in chunks as they arrive. */
	chat(messages: Message[], options: ModelOptions): AsyncGenerator<string>;
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
