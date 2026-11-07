process.env.WS_NO_BUFFER_UTIL = '1';
process.env.WS_NO_UTF_8_VALIDATE = '1';

import WebSocket from 'ws';
import type { AgentId } from '../db/schema';

export type SwitchConnectionModel =
  | 'always_on'
  | 'session_addressable'
  | 'auto_session'
  | 'session_passive';

export type SwitchAddressingPolicy =
  | 'owner_only'
  | 'owner_and_owner_agents'
  | 'anyone';

export interface SwitchRegistrationPayload {
  name: string;
  display_name?: string;
  description: string;
  connector_type: string;
  integration_profile: {
    connection_model: SwitchConnectionModel;
    message_exchange: boolean;
    pre_invocation_mediation: string[];
    post_invocation_mediation: string[];
    event_reporting: string[];
    command_capabilities?: string[];
  };
  icon_url?: string;
  tools?: string[];
  models?: string[];
  metadata?: Record<string, unknown>;
  overwrite?: boolean;
}

export interface SwitchRegistrationResponse {
  id: string;
  api_key: string;
}

export interface SwitchAttachmentPointer {
  filename: string;
  mimetype: string;
  size: number;
  mxc: string;
  msgtype: string;
}

export interface SwitchMessagePayload {
  addressed: boolean;
  sender: string;
  sender_name: string;
  message_id: string;
  body: string;
  timestamp: number;
  thread_id: string | null;
  attachments: SwitchAttachmentPointer[];
}

export interface SwitchCommandPayload {
  command: string;
  args: string;
  user_id: string;
  user_name: string;
  thread_id: string | null;
}

export interface SwitchRoomJoinPayload {
  member: string;
  member_name: string;
  timestamp: number;
  listening: boolean;
}

export interface SwitchDomainEventEnvelope<T = SwitchMessagePayload | SwitchCommandPayload | SwitchRoomJoinPayload> {
  event: 'message' | 'command' | 'room_join';
  data: {
    type: 'message' | 'command' | 'room_join';
    room_id: string;
    bridge_id: string | null;
    channel_type: 'channel_public' | 'channel_private' | null;
    payload: T;
    sequence: number;
  };
  id: number;
}

export interface SwitchConnectionStateFrame {
  type: 'connection_state';
  connection_id: string;
  agent_id: string;
  generation: number;
  scope: 'single' | 'all';
  filter: 'all' | 'addressed';
  spawn_capable: boolean;
  rooms: string[];
  cursor: number;
  protocol: number;
  heartbeat_interval_seconds: number;
  server?: Record<string, unknown>;
  client?: Record<string, unknown>;
}

export interface SwitchPingFrame {
  type: 'ping';
}

export interface SwitchGapFrame {
  type: 'gap';
  from_sequence: number;
  resumed_at: number;
  resumed_position: number;
  rooms: string[];
  all_rooms: boolean;
  reason: string;
}

export interface SwitchEvictedFrame {
  type: 'evicted';
  code:
    | 'taken_over'
    | 'heartbeat_lapsed'
    | 'no_stream'
    | 'unfenced'
    | 'connection_error'
    | 'closed';
  reason?: string;
}

export interface SwitchRefusedFrame {
  type: 'refused';
  status: number;
  detail: string;
}

export interface SwitchSubscriptionChangedFrame {
  type: 'subscription_changed';
  rooms: string[];
  reason: string;
}

export type SwitchControlFrame =
  | SwitchConnectionStateFrame
  | SwitchPingFrame
  | SwitchGapFrame
  | SwitchEvictedFrame
  | SwitchRefusedFrame
  | SwitchSubscriptionChangedFrame;

/**
 * HTTP Client for the Switch Agent Protocol
 * Implements exact endpoints documented at https://docs.switchagents.ai/switch-rooms/internals/agent-protocol.md
 */
export class SwitchHttpClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  getServerUrl(): string {
    return this.baseUrl;
  }

  /**
   * GET /health — public probe for the Switch bridge base URL.
   */
  async probeHealth(): Promise<{ ok: boolean; status: number; data?: unknown }> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(4000),
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data };
    } catch {
      return { ok: false, status: 0 };
    }
  }

  /**
   * POST /agents — registers an agent once using the deployment's registration key.
   */
  async registerAgent(
    registrationToken: string,
    payload: SwitchRegistrationPayload,
  ): Promise<SwitchRegistrationResponse> {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(payload.name)) {
      throw new Error(
        `Invalid Switch agent name "${payload.name}": must match ^[a-z0-9][a-z0-9._-]*$`,
      );
    }

    const res = await fetch(`${this.baseUrl}/agents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${registrationToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Switch POST /agents failed (${res.status}): ${errBody}`);
    }

    return (await res.json()) as SwitchRegistrationResponse;
  }

  /**
   * GET /agents/{agent_id}/ops — discovers available operations and their JSON schemas.
   */
  async discoverOperations(
    switchAgentId: string,
    agentApiKey: string,
  ): Promise<Record<string, { description: string; input_schema: Record<string, unknown> }>> {
    const res = await fetch(`${this.baseUrl}/agents/${encodeURIComponent(switchAgentId)}/ops`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${agentApiKey}`,
      },
    });
    if (!res.ok) {
      throw new Error(`Switch GET /ops failed (${res.status})`);
    }
    const body = (await res.json()) as {
      operations: Record<string, { description: string; input_schema: Record<string, unknown> }>;
    };
    return body.operations;
  }

  /**
   * POST /agents/{agent_id}/ops/{operation} — invokes an operation with unwrapped arguments.
   */
  async callOperation<TResult = unknown>(params: {
    switchAgentId: string;
    agentApiKey: string;
    operation: string;
    args?: Record<string, unknown>;
    connectionId?: string;
  }): Promise<TResult> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${params.agentApiKey}`,
      'Content-Type': 'application/json',
    };
    if (params.connectionId) {
      headers['X-Switch-Connection-Id'] = params.connectionId;
    }

    const res = await fetch(
      `${this.baseUrl}/agents/${encodeURIComponent(params.switchAgentId)}/ops/${encodeURIComponent(params.operation)}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(params.args ?? {}),
      },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `Switch operation "${params.operation}" failed (${res.status}): ${text}`,
      );
    }

    const body = (await res.json()) as { result: TResult };
    return body.result;
  }

  /**
   * POST /agents/{agent_id}/ops/update_agent_detail — sets addressing policy.
   */
  async updateAddressing(params: {
    switchAgentId: string;
    agentApiKey: string;
    addressing: SwitchAddressingPolicy;
  }): Promise<unknown> {
    return this.callOperation({
      switchAgentId: params.switchAgentId,
      agentApiKey: params.agentApiKey,
      operation: 'update_agent_detail',
      args: {
        agent_id: params.switchAgentId,
        addressing: params.addressing,
      },
    });
  }

  /**
   * POST /agents/{agent_id}/message — posts a message directly to a room without requiring an open socket.
   */
  async postMessageDirect(params: {
    switchAgentId: string;
    agentApiKey: string;
    roomId: string;
    content: string;
    threadId?: string | null;
  }): Promise<unknown> {
    const res = await fetch(
      `${this.baseUrl}/agents/${encodeURIComponent(params.switchAgentId)}/message`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${params.agentApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          room_id: params.roomId,
          content: params.content,
          ...(params.threadId ? { thread_id: params.threadId } : {}),
        }),
      },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Switch POST /message failed (${res.status}): ${text}`);
    }

    return res.json();
  }
}

/**
 * WebSocket Client for the Switch Agent Connection Protocol
 * Implements https://docs.switchagents.ai/switch-rooms/internals/agent-connection.md
 * - Immediate pong response with cursor on 2-second ping frames
 * - Cursor tracking and resume via start_from & expected_generation
 * - Final stop on taken_over eviction
 */
export class SwitchAgentWebSocketConnection {
  public readonly agentKey: AgentId;
  public readonly switchAgentId: string;
  private readonly agentApiKey: string;
  public readonly connectionId: string;
  private readonly wsBaseUrl: string;
  private ws: WebSocket | null = null;
  public generation: number;
  public cursor: number;
  public coveredRooms: string[] = [];
  private permanentlyStopped = false;
  private onEventCallback?: (
    envelope: SwitchDomainEventEnvelope,
    agentKey: AgentId,
  ) => Promise<void> | void;
  private onStateCallback?: (state: SwitchConnectionStateFrame) => void;

  constructor(params: {
    agentKey: AgentId;
    switchAgentId: string;
    agentApiKey: string;
    connectionId: string;
    httpBaseUrl: string;
    initialGeneration?: number;
    initialCursor?: number;
    onEvent?: (
      envelope: SwitchDomainEventEnvelope,
      agentKey: AgentId,
    ) => Promise<void> | void;
    onState?: (state: SwitchConnectionStateFrame) => void;
  }) {
    this.agentKey = params.agentKey;
    this.switchAgentId = params.switchAgentId;
    this.agentApiKey = params.agentApiKey;
    this.connectionId = params.connectionId;
    this.wsBaseUrl = params.httpBaseUrl
      .replace(/^http:\/\//i, 'ws://')
      .replace(/^https:\/\//i, 'wss://')
      .replace(/\/+$/, '');
    this.generation = params.initialGeneration ?? 0;
    this.cursor = params.initialCursor ?? 0;
    this.onEventCallback = params.onEvent;
    this.onStateCallback = params.onState;
  }

  async connect(roomsToClaim: string[] = []): Promise<SwitchConnectionStateFrame> {
    if (this.permanentlyStopped) {
      throw new Error(
        `Connection ${this.connectionId} for ${this.agentKey} was taken_over and must not reconnect.`,
      );
    }

    const query = new URLSearchParams({
      connection_id: this.connectionId,
      scope: 'all',
      filter: 'all',
      start_from: this.cursor > 0 ? String(this.cursor) : 'head',
      client: 'talentloop-switch-client',
      client_version: '1.0.0',
    });

    if (roomsToClaim.length > 0) {
      query.set('rooms', roomsToClaim.join(','));
    }
    if (this.generation > 0) {
      query.set('expected_generation', String(this.generation));
    }

    const url = `${this.wsBaseUrl}/agents/${encodeURIComponent(this.switchAgentId)}/connection/ws?${query.toString()}`;

    return new Promise<SwitchConnectionStateFrame>((resolve, reject) => {
      let stateResolved = false;
      const socket = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.agentApiKey}`,
        },
      });
      this.ws = socket;

      socket.on('message', (rawData) => {
        try {
          const text = rawData.toString();
          const parsed = JSON.parse(text) as
            | SwitchControlFrame
            | SwitchDomainEventEnvelope;

          // 1. Answer ping frames IMMEDIATELY before any event work (Switch 6s TTL rule)
          if ('type' in parsed && parsed.type === 'ping') {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: 'pong', cursor: this.cursor }));
            }
            return;
          }

          // 2. Handle connection_state (always first frame)
          if ('type' in parsed && parsed.type === 'connection_state') {
            this.generation = parsed.generation;
            this.coveredRooms = parsed.rooms;
            this.cursor = parsed.cursor;
            this.onStateCallback?.(parsed);
            if (!stateResolved) {
              stateResolved = true;
              resolve(parsed);
            }
            return;
          }

          // 3. Handle gap frame
          if ('type' in parsed && parsed.type === 'gap') {
            this.cursor = parsed.resumed_at;
            return;
          }

          // 4. Handle subscription_changed frame
          if ('type' in parsed && parsed.type === 'subscription_changed') {
            this.coveredRooms = parsed.rooms;
            return;
          }

          // 5. Handle refused frame
          if ('type' in parsed && parsed.type === 'refused') {
            if (!stateResolved) {
              stateResolved = true;
              reject(
                new Error(
                  `Switch connection refused (${parsed.status}): ${parsed.detail}`,
                ),
              );
            }
            return;
          }

          // 6. Handle evicted frame
          if ('type' in parsed && parsed.type === 'evicted') {
            if (parsed.code === 'taken_over') {
              // Switch specification: taken_over is final, never reconnect.
              this.permanentlyStopped = true;
            }
            return;
          }

          // 7. Handle domain event envelope (message, command, room_join)
          if ('event' in parsed && typeof parsed.id === 'number') {
            if (parsed.id > this.cursor) {
              this.cursor = parsed.id;
            }
            if (this.onEventCallback) {
              void Promise.resolve(this.onEventCallback(parsed, this.agentKey));
            }
          }
        } catch {
          // Ignore malformed frame
        }
      });

      socket.on('error', (err) => {
        if (!stateResolved) {
          stateResolved = true;
          reject(err);
        }
      });

      socket.on('close', (code) => {
        if (code === 4409) {
          // Potential taken_over or conflict
        }
        if (!stateResolved) {
          stateResolved = true;
          reject(new Error(`Switch WebSocket closed before connection_state (code ${code})`));
        }
      });
    });
  }

  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.permanentlyStopped = true;
    if (this.ws) {
      try {
        this.ws.close(1000, 'Client shutdown');
        this.ws.terminate();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }
}
