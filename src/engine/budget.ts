import { HARD_LIMITS } from "../types.js";

export class Semaphore {
  readonly #limit: number;
  #active = 0;
  readonly #queue: Array<() => void> = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > HARD_LIMITS.concurrency) {
      throw new Error(`Concurrency must be between 1 and ${HARD_LIMITS.concurrency}`);
    }
    this.#limit = limit;
  }

  async use<T>(work: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await work();
    } finally {
      this.#release();
    }
  }

  async #acquire(): Promise<void> {
    if (this.#active < this.#limit) {
      this.#active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.#queue.push(resolve));
    this.#active += 1;
  }

  #release(): void {
    this.#active -= 1;
    this.#queue.shift()?.();
  }
}

export class AgentBudget {
  #used = 0;

  constructor(readonly maximum: number, used = 0) {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > HARD_LIMITS.maxAgents) {
      throw new Error(`Agent budget must be between 1 and ${HARD_LIMITS.maxAgents}`);
    }
    if (!Number.isInteger(used) || used < 0 || used > maximum) {
      throw new Error(`Used agent budget must be between 0 and ${maximum}`);
    }
    this.#used = used;
  }

  consume(): void {
    if (this.#used >= this.maximum) {
      throw new Error(`Agent budget exhausted (${this.#used}/${this.maximum})`);
    }
    this.#used += 1;
  }

  get used(): number {
    return this.#used;
  }
}
