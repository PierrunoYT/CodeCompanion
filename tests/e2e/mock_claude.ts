import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { anthropicStream } from '../../src/main/llm/test_server';

type Block = Parameters<typeof anthropicStream>[0][number];

export interface ScriptedTurn {
  blocks: Block[];
  stopReason: 'end_turn' | 'tool_use';
}

// A request the API rejects, e.g. a rate limit. retryAfterSeconds is sent as the Retry-After header.
export interface ScriptedFailure {
  failure: { status: number; type: string; retryAfterSeconds?: number };
}

// Mock Anthropic API for end-to-end tests. Streaming requests (agent turns) get the scripted turns in order;
// non-streaming requests (the small-model title) get a fixed structured answer.
export class MockClaude {
  readonly agentRequests: any[] = [];
  // Requests to summarize old turns (compact chat).
  readonly summaryRequests: any[] = [];
  private turns: Array<ScriptedTurn | ScriptedFailure> = [];
  private server: Server;

  constructor() {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        if (!body.stream) {
          // A request to compact the chat asks for a summary; everything else asked for a title.
          const prompt = JSON.stringify(body.messages?.[0]?.content ?? '');
          if (prompt.includes('Summarize the earlier part')) this.summaryRequests.push(body);
          const answer = prompt.includes('Summarize the earlier part')
            ? '{"summary":"E2E SUMMARY of the earlier work."}'
            : '{"title":"Explore the project"}';
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'msg_title',
              type: 'message',
              role: 'assistant',
              model: body.model,
              content: [{ type: 'text', text: answer }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
          );
          return;
        }
        this.agentRequests.push(body);
        const turn = this.turns.shift();
        if (!turn) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'no scripted turn' } }));
          return;
        }
        if ('failure' in turn) {
          const { status, type, retryAfterSeconds } = turn.failure;
          res.writeHead(status, {
            'content-type': 'application/json',
            ...(retryAfterSeconds === undefined ? {} : { 'retry-after': String(retryAfterSeconds) }),
          });
          res.end(JSON.stringify({ type: 'error', error: { type, message: `scripted ${status}` } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const { event, data } of anthropicStream(turn.blocks, turn.stopReason)) {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
        res.end();
      });
    });
  }

  script(...turns: Array<ScriptedTurn | ScriptedFailure>): void {
    this.turns.push(...turns);
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
