import type {
  LocalApplyProposalClaim,
  LocalApplyProposalListResult,
  LocalApplyProposalStatus,
} from '@chatsplice/protocol';

interface LocalApplyDispatchClient {
  listLocalApplyProposals(): Promise<LocalApplyProposalListResult>;
  claimLocalApplyProposal(proposalId: string): Promise<LocalApplyProposalClaim | null>;
  executeLocalApplyProposal(claimId: string): Promise<LocalApplyProposalStatus | null>;
  releaseLocalApplyProposal(claimId: string): Promise<LocalApplyProposalListResult>;
}

interface LocalApplyAutoDispatcherOptions {
  readonly pollIntervalMs?: number;
}

/** Electron authorizes bounded work; execution and results live in the daemon. */
export class LocalApplyAutoDispatcher {
  readonly #client: LocalApplyDispatchClient;
  readonly #pollIntervalMs: number;
  #timer: NodeJS.Timeout | undefined;
  #checking = false;
  #stopped = true;

  public constructor(
    client: LocalApplyDispatchClient,
    options: LocalApplyAutoDispatcherOptions = {},
  ) {
    this.#client = client;
    this.#pollIntervalMs = options.pollIntervalMs ?? 500;
  }

  public async start(): Promise<void> {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#timer = setInterval(() => void this.wake(), this.#pollIntervalMs);
    this.#timer.unref();
    await this.wake();
  }

  public async wake(): Promise<void> {
    if (this.#stopped || this.#checking) return;
    this.#checking = true;
    let claim: LocalApplyProposalClaim | null = null;
    try {
      const proposals = await this.#client.listLocalApplyProposals();
      const proposal = proposals.proposals[0];
      if (proposal === undefined || this.#stopped) return;
      claim = await this.#client.claimLocalApplyProposal(proposal.proposal_id);
      if (claim === null) return;
      if (this.#stopped) {
        await this.#client.releaseLocalApplyProposal(claim.claim_id);
        return;
      }
      await this.#client.executeLocalApplyProposal(claim.claim_id);
    } catch {
      // A lost HTTP response is not an execution failure. Release is a no-op
      // once execution has started; the daemon will publish the real result.
      if (claim !== null)
        await this.#client.releaseLocalApplyProposal(claim.claim_id).catch(() => undefined);
      // Unstarted claims also have a bounded lease if release cannot connect.
    } finally {
      this.#checking = false;
    }
  }

  public stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
