import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { anthropicStream } from '../../src/main/llm/test_server';

type Block = Parameters<typeof anthropicStream>[0][number];

export interface ScriptedTurn {
  blocks: Block[];
  stopReason: 'end_turn' | 'tool_use';
}

// Mock Anthropic API for end-to-end tests. Streaming requests (agent turns) get the scripted turns in order;
// non-streaming requests (the small-model title) get a fixed structured answer.
export class MockClaude {
  readonly agentRequests: any[] = [];
  private turns: ScriptedTurn[] = [];
  private server: Server;

  constructor() {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        if (!body.stream) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'msg_title',
              type: 'message',
              role: 'assistant',
              model: body.model,
              content: [{ type: 'text', text: '{"title":"Explore the project"}' }],
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
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const { event, data } of anthropicStream(turn.blocks, turn.stopReason)) {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
        res.end();
      });
    });
  }

  script(...turns: ScriptedTurn[]): void {
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
