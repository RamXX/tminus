/**
 * Production Workflow wrapper for OnboardingWorkflow.
 *
 * The core OnboardingWorkflow in @tminus/workflow-onboarding is a plain
 * testable class that accepts (env, deps) and has run(params). The
 * Cloudflare Workflows runtime requires classes that extend
 * WorkflowEntrypoint and implement run(event, step).
 *
 * This wrapper bridges the gap -- same pattern as do-wrappers.ts for DOs.
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import {
  OnboardingWorkflow as OnboardingWorkflowCore,
} from "@tminus/workflow-onboarding";
import type { OnboardingParams } from "@tminus/workflow-onboarding";

/**
 * Production wrapper for OnboardingWorkflow.
 *
 * Extends WorkflowEntrypoint so the Cloudflare Workflows runtime can
 * construct and invoke it. Delegates the actual logic to the testable
 * core class.
 */
export class OnboardingWorkflow extends WorkflowEntrypoint<Env, OnboardingParams> {
  async run(
    event: { payload: OnboardingParams; timestamp: Date; instanceId: string },
    step: { do: <T>(name: string, fn: () => Promise<T>) => Promise<T> },
  ) {
    const core = new OnboardingWorkflowCore(this.env);
    return core.run(event.payload);
  }
}
