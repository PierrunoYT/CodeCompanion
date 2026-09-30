import { z } from 'zod';
import { defineTool } from './types';

// Plan mode: the model describes what it intends to do, the user approves or declines on an approval card, and the
// decision comes back to the model before any side effect happens. alwaysAsk keeps the card even in Auto mode, so
// turning plan mode on never silently pretends the user approved a plan they did not see. The agent loop runs this
// call before the rest of its batch and skips those other calls until the decision is back.
export const proposePlanTool = defineTool({
  name: 'propose_plan',
  description:
    'The user turned on plan mode: before changing files or running commands for a multi-step task, call this first and wait for the decision. Describe the steps concretely (files, commands, order) and keep the plan short enough to read in a minute. Do not call any other tool in the same response: those calls are not run until the plan is decided, and you should call them again afterwards. A single read or a one-step change does not need a plan.',
  schema: z.object({
    plan: z.string().describe('The plan in markdown: numbered steps, files to change, commands to run.'),
    summary: z.string().describe('One line describing the goal, shown as the card title.'),
  }),
  requiresApproval: true,
  alwaysAsk: true,
  preview: async ({ summary, plan }) => ({ title: summary || 'Plan', text: plan }),
  async run({ summary }) {
    return {
      content:
        'The user approved the plan. Carry it out step by step; if reality differs from the plan, say what changed and why before deviating.',
      summary: `Plan approved: ${summary || '(untitled)'}`,
    };
  },
});
