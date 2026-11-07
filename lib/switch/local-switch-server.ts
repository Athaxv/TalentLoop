process.env.WS_NO_BUFFER_UTIL = '1';
process.env.WS_NO_UTF_8_VALIDATE = '1';

import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type {
  SwitchAddressingPolicy,
  SwitchAttachmentPointer,
  SwitchConnectionStateFrame,
  SwitchDomainEventEnvelope,
  SwitchMessagePayload,
  SwitchRegistrationPayload,
} from './protocol-client';

interface RegisteredSwitchAgent {
  id: string;
  name: string;
  displayName: string;
  description: string;
  connectorType: string;
  apiKey: string;
  addressing: SwitchAddressingPolicy;
  integrationProfile: SwitchRegistrationPayload['integration_profile'];
  sequenceCounter: number;
  eventBuffer: SwitchDomainEventEnvelope[];
}

interface SwitchRoomState {
  roomId: string;
  name: string;
  description: string;
  instructions: string;
  channelType: 'channel_public' | 'channel_private';
  participants: Set<string>; // participant IDs or agent names
  roles: Map<
    string,
    {
      name: string;
      instructions: string;
      exclusive: boolean;
      holders: Set<string>;
    }
  >;
  documents: Map<
    string,
    {
      name: string;
      description: string;
      instructions: string;
      content: string;
      authorAgentId: string;
    }
  >;
  aliases: Map<string, string>; // alias -> agentName
  seqCounter: number;
  messages: Array<{
    seq: number;
    messageId: string;
    sender: string;
    senderName: string;
    body: string;
    threadId: string | null;
    attachments: SwitchAttachmentPointer[];
    timestamp: number;
  }>;
}

interface ActiveAgentSocket {
  connectionId: string;
  agentId: string;
  agentName: string;
  generation: number;
  scope: 'single' | 'all';
  filter: 'all' | 'addressed';
  rooms: Set<string>;
  cursor: number;
  ws: WebSocket;
  lastPongAt: number;
  pingTimer: ReturnType<typeof setInterval>;
}

/**
 * Local Switch Protocol Server
 * Implements the documented Switch Agent Bridge HTTP + WebSocket wire protocol:
 * - GET /health
 * - POST /agents (Registration Token auth, overwrite handling, api_key minting)
 * - GET /agents/{agent_id}/ops
 * - POST /agents/{agent_id}/ops/{operation}
 * - POST /agents/{agent_id}/message
 * - GET /agents/{agent_id}/connection/ws (WebSocket upgrade, connection_state, 2s ping/pong, sequenced per-agent event buffer, addressing resolution)
 *
 * Used automatically when an external Docker Switch Core instance is not running,
 * guaranteeing that TalentLoop agents always communicate over the real Switch wire protocol.
 */
export class LocalSwitchProtocolServer {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private port: number;
  private readonly registrationToken: string;
  private readonly serverName = 'talentloop.local';
  private agentsById = new Map<string, RegisteredSwitchAgent>();
  private agentsByName = new Map<string, RegisteredSwitchAgent>();
  private agentsByApiKey = new Map<string, RegisteredSwitchAgent>();
  private roomsById = new Map<string, SwitchRoomState>();
  private roomsByName = new Map<string, SwitchRoomState>();
  private activeConnections = new Map<string, ActiveAgentSocket>(); // connectionId -> socket

  constructor(port = 8400, registrationToken?: string) {
    this.port = port;
    this.registrationToken =
      registrationToken ??
      process.env.AGENT_REGISTRATION_TOKEN ??
      'switch_reg_bootstrap_token_talentloop_2026';
  }

  getBaseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<string> {
    if (this.server) {
      return this.getBaseUrl();
    }

    const httpServer = http.createServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });

    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;

    httpServer.on('upgrade', (request, socket, head) => {
      const urlObj = new URL(request.url ?? '/', `http://127.0.0.1:${this.port}`);
      const wsMatch = urlObj.pathname.match(/^\/agents\/([^/]+)\/connection\/ws$/);
      if (!wsMatch) {
        socket.destroy();
        return;
      }

      const agentId = decodeURIComponent(wsMatch[1]);
      const authHeader = request.headers['authorization'] ?? '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const agent = this.agentsById.get(agentId);

      if (!agent || !token || agent.apiKey !== token) {
        wss.handleUpgrade(request, socket, head, (ws) => {
          ws.close(4401, 'Unauthorized');
        });
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        this.handleWebSocketConnection(ws, agent, urlObj.searchParams);
      });
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          // Port already in use by another instance of the server
          resolve();
        } else {
          reject(err);
        }
      });
      httpServer.listen(this.port, '127.0.0.1', () => {
        const addr = httpServer.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
        }
        resolve();
      });
    });

    this.server = httpServer;
    return this.getBaseUrl();
  }

  async stop(): Promise<void> {
    for (const conn of this.activeConnections.values()) {
      clearInterval(conn.pingTimer);
      try {
        conn.ws.close(1000, 'Server stopping');
      } catch {
        // ignore
      }
    }
    this.activeConnections.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    if (this.server) {
      this.server.closeAllConnections();
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }

  /**
   * Simulates a human Slack user posting a message into a Switch room via the Collaboration Bridge.
   * Follows Switch's "Life of a message" puppet flow:
   * - Creates/resolves `@switch-user-<slackUserId>:talentloop.local`
   * - Writes event to room log with next `seq`
   * - Evaluates addressing (@agent-name, @role, or default Milo coordinator)
   * - Pushes sequenced event to each member agent's buffer and open WebSocket
   */
  public postHumanBridgeMessage(params: {
    roomNameOrId: string;
    slackUserId: string;
    slackUserName: string;
    body: string;
    threadId?: string | null;
    attachments?: SwitchAttachmentPointer[];
  }): { roomId: string; seq: number; messageId: string } {
    const room =
      this.roomsById.get(params.roomNameOrId) ??
      this.roomsByName.get(params.roomNameOrId);
    if (!room) {
      throw new Error(`Switch room not found: ${params.roomNameOrId}`);
    }

    const senderParticipantId = `@switch-user-${params.slackUserId.toLowerCase()}:${this.serverName}`;
    room.participants.add(senderParticipantId);

    return this.appendRoomMessage({
      room,
      senderId: senderParticipantId,
      senderName: params.slackUserName,
      body: params.body,
      threadId: params.threadId ?? null,
      attachments: params.attachments ?? [],
    });
  }

  public getRoomTranscript(roomNameOrId: string): SwitchRoomState['messages'] {
    const room =
      this.roomsById.get(roomNameOrId) ?? this.roomsByName.get(roomNameOrId);
    return room ? [...room.messages] : [];
  }

  private async handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const urlObj = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    const pathname = urlObj.pathname;
    const method = req.method ?? 'GET';

    // 1. Public /health probe
    if (method === 'GET' && pathname === '/health') {
      this.sendJson(res, 200, {
        status: 'ok',
        server: 'switch-core-protocol',
        version: '0.31.0',
        server_name: this.serverName,
        registered_agents: this.agentsById.size,
        rooms: this.roomsById.size,
      });
      return;
    }

    // 1b. POST /bridge/human-message (Slack Collaboration Bridge Inbound Relay)
    if (method === 'POST' && pathname === '/bridge/human-message') {
      const body = (await this.readJsonBody(req)) as {
        room_id?: string;
        slack_user_id?: string;
        slack_user_name?: string;
        body?: string;
        thread_id?: string | null;
        attachments?: SwitchAttachmentPointer[];
      };
      const result = this.postHumanBridgeMessage({
        roomNameOrId: body.room_id || 'talentloop-job-search',
        slackUserId: body.slack_user_id || 'U_HUMAN',
        slackUserName: body.slack_user_name || 'Candidate',
        body: body.body || '',
        threadId: body.thread_id ?? null,
        attachments: body.attachments ?? [],
      });
      this.sendJson(res, 200, result);
      return;
    }

    // 2. POST /agents (Agent Registration)
    if (method === 'POST' && pathname === '/agents') {
      const bearer = this.extractBearer(req);
      if (!bearer || bearer !== this.registrationToken) {
        this.sendJson(res, 401, {
          detail: 'Valid registration key required for POST /agents',
        });
        return;
      }

      const body = (await this.readJsonBody(req)) as SwitchRegistrationPayload;
      if (
        !body?.name ||
        !/^[a-z0-9][a-z0-9._-]*$/.test(body.name) ||
        !body.description ||
        !body.connector_type ||
        !body.integration_profile
      ) {
        this.sendJson(res, 400, { detail: 'Invalid agent registration payload' });
        return;
      }

      const existing = this.agentsByName.get(body.name);
      if (existing && !body.overwrite) {
        this.sendJson(res, 409, {
          detail: `Agent "${body.name}" already exists. Pass overwrite: true to reissue key.`,
        });
        return;
      }

      const agentId =
        existing?.id ?? `@switch-agent-${body.name}:${this.serverName}`;
      const apiKey = `swk_${body.name}_${crypto.randomBytes(16).toString('hex')}`;

      if (existing) {
        this.agentsByApiKey.delete(existing.apiKey);
      }

      const record: RegisteredSwitchAgent = {
        id: agentId,
        name: body.name,
        displayName: body.display_name ?? body.name,
        description: body.description,
        connectorType: body.connector_type,
        apiKey,
        addressing: existing?.addressing ?? 'owner_only',
        integrationProfile: body.integration_profile,
        sequenceCounter: existing?.sequenceCounter ?? 0,
        eventBuffer: existing?.eventBuffer ?? [],
      };

      this.agentsById.set(agentId, record);
      this.agentsByName.set(body.name, record);
      this.agentsByApiKey.set(apiKey, record);

      this.sendJson(res, 200, { id: agentId, api_key: apiKey });
      return;
    }

    // All remaining /agents/* routes require an agent's API key (registration key is rejected!)
    const bearer = this.extractBearer(req);
    if (!bearer || bearer === this.registrationToken) {
      this.sendJson(res, 401, {
        detail: 'Agent API key required (registration key is not permitted here)',
      });
      return;
    }

    const callerAgent = this.agentsByApiKey.get(bearer);
    if (!callerAgent) {
      this.sendJson(res, 401, { detail: 'Invalid agent API key' });
      return;
    }

    // 3. GET /agents/{agent_id}/ops
    const opsListMatch = pathname.match(/^\/agents\/([^/]+)\/ops$/);
    if (method === 'GET' && opsListMatch) {
      this.sendJson(res, 200, {
        operations: {
          update_agent_detail: {
            description: 'Update agent addressing policy and metadata',
            input_schema: { type: 'object', properties: { agent_id: { type: 'string' }, addressing: { type: 'string' } } },
          },
          list_rooms: { description: 'List rooms the agent belongs to', input_schema: { type: 'object' } },
          list_all_rooms: { description: 'List all workspace rooms', input_schema: { type: 'object' } },
          create_room: { description: 'Create a Switch room', input_schema: { type: 'object' } },
          connect_to_room: { description: 'Claim a room and read its context', input_schema: { type: 'object' } },
          invite_agent_to_room: { description: 'Invite an agent to a room', input_schema: { type: 'object' } },
          define_role: { description: 'Define a role in a room', input_schema: { type: 'object' } },
          assume_role: { description: 'Assume a role in a room', input_schema: { type: 'object' } },
          post_message: { description: 'Post a message to a room', input_schema: { type: 'object' } },
          send_targeted_message: { description: 'Send a targeted message addressing another agent', input_schema: { type: 'object' } },
          read_context: { description: 'Read room context and recent messages', input_schema: { type: 'object' } },
          create_room_document: { description: 'Create a room-scoped document', input_schema: { type: 'object' } },
          update_room_document: { description: 'Update a room-scoped document', input_schema: { type: 'object' } },
          load_internal_documents: { description: 'Load room-scoped documents', input_schema: { type: 'object' } },
        },
      });
      return;
    }

    // 4. POST /agents/{agent_id}/ops/{operation}
    const opInvokeMatch = pathname.match(/^\/agents\/([^/]+)\/ops\/([^/]+)$/);
    if (method === 'POST' && opInvokeMatch) {
      const operation = decodeURIComponent(opInvokeMatch[2]);
      const connectionIdHeader = req.headers['x-switch-connection-id'] as string | undefined;
      const args = (await this.readJsonBody(req)) as Record<string, unknown>;

      try {
        const result = this.executeOperation(callerAgent, operation, args, connectionIdHeader);
        this.sendJson(res, 200, { result });
      } catch (err) {
        const status = (err as { status?: number }).status ?? 400;
        this.sendJson(res, status, { detail: (err as Error).message });
      }
      return;
    }

    // 5. POST /agents/{agent_id}/message
    const directMsgMatch = pathname.match(/^\/agents\/([^/]+)\/message$/);
    if (method === 'POST' && directMsgMatch) {
      const body = (await this.readJsonBody(req)) as {
        room_id?: string;
        content?: string;
        thread_id?: string | null;
      };
      if (!body?.room_id || !body?.content) {
        this.sendJson(res, 400, { detail: 'room_id and content are required' });
        return;
      }
      const room =
        this.roomsById.get(body.room_id) ?? this.roomsByName.get(body.room_id);
      if (!room) {
        this.sendJson(res, 404, { detail: `Unknown room: ${body.room_id}` });
        return;
      }
      const msg = this.appendRoomMessage({
        room,
        senderId: callerAgent.id,
        senderName: callerAgent.name,
        body: body.content,
        threadId: body.thread_id ?? null,
        attachments: [],
      });
      this.sendJson(res, 200, { ok: true, ...msg });
      return;
    }

    this.sendJson(res, 404, { detail: `Route not found: ${method} ${pathname}` });
  }

  private executeOperation(
    caller: RegisteredSwitchAgent,
    operation: string,
    args: Record<string, unknown>,
    connectionId?: string,
  ): unknown {
    switch (operation) {
      case 'update_agent_detail': {
        const addressing = args.addressing as SwitchAddressingPolicy | undefined;
        if (
          addressing === 'owner_only' ||
          addressing === 'owner_and_owner_agents' ||
          addressing === 'anyone'
        ) {
          caller.addressing = addressing;
        }
        return { agent_id: caller.id, name: caller.name, addressing: caller.addressing };
      }

      case 'list_rooms':
      case 'list_all_rooms': {
        const rooms = [...this.roomsById.values()].map((r) => ({
          room_id: r.roomId,
          name: r.name,
          description: r.description,
          participants: [...r.participants],
        }));
        return { rooms };
      }

      case 'create_room': {
        const name = String(args.name ?? 'talentloop-job-search').trim();
        let room = this.roomsByName.get(name);
        if (!room) {
          const roomId = `!room-${name}:${this.serverName}`;
          room = {
            roomId,
            name,
            description: String(args.description ?? ''),
            instructions: String(args.instructions ?? ''),
            channelType:
              args.channel_type === 'channel_private'
                ? 'channel_private'
                : 'channel_public',
            participants: new Set([caller.id, caller.name]),
            roles: new Map(),
            documents: new Map(),
            aliases: new Map(),
            seqCounter: 0,
            messages: [],
          };
          this.roomsById.set(roomId, room);
          this.roomsByName.set(name, room);
        } else {
          room.participants.add(caller.id);
          room.participants.add(caller.name);
        }
        return { room_id: room.roomId, name: room.name };
      }

      case 'invite_agent_to_room': {
        const roomKey = String(args.room_id ?? args.room ?? 'talentloop-job-search');
        const targetAgentName = String(args.agent_id ?? args.agent_name ?? '');
        const room = this.roomsById.get(roomKey) ?? this.roomsByName.get(roomKey);
        if (!room) {
          throw Object.assign(new Error(`Room not found: ${roomKey}`), { status: 404 });
        }
        const target =
          this.agentsById.get(targetAgentName) ?? this.agentsByName.get(targetAgentName);
        if (target) {
          room.participants.add(target.id);
          room.participants.add(target.name);
        }
        return { room_id: room.roomId, invited: targetAgentName };
      }

      case 'connect_to_room': {
        const roomKey = String(args.room_id ?? args.room ?? 'talentloop-job-search');
        const room = this.roomsById.get(roomKey) ?? this.roomsByName.get(roomKey);
        if (!room) {
          throw Object.assign(new Error(`Room not found: ${roomKey}`), { status: 404 });
        }
        room.participants.add(caller.id);
        room.participants.add(caller.name);
        if (connectionId) {
          const conn = this.activeConnections.get(connectionId);
          if (conn) conn.rooms.add(room.roomId);
        }
        return {
          room_id: room.roomId,
          name: room.name,
          instructions: room.instructions,
          participants: [...room.participants],
          roles: [...room.roles.values()].map((r) => ({
            name: r.name,
            instructions: r.instructions,
            exclusive: r.exclusive,
            holders: [...r.holders],
          })),
          documents: [...room.documents.values()],
        };
      }

      case 'define_role': {
        const roomKey = String(args.room_id ?? 'talentloop-job-search');
        const room = this.roomsById.get(roomKey) ?? this.roomsByName.get(roomKey);
        if (!room) throw new Error(`Room not found: ${roomKey}`);
        const roleName = String(args.name ?? '').trim();
        if (!roleName || /\s/.test(roleName)) {
          throw new Error('Role name cannot be empty or contain spaces');
        }
        room.roles.set(roleName, {
          name: roleName,
          instructions: String(args.instructions ?? ''),
          exclusive: Boolean(args.exclusive),
          holders: new Set(),
        });
        return { room_id: room.roomId, role: roleName };
      }

      case 'assume_role': {
        const roomKey = String(args.room_id ?? 'talentloop-job-search');
        const room = this.roomsById.get(roomKey) ?? this.roomsByName.get(roomKey);
        if (!room) throw new Error(`Room not found: ${roomKey}`);
        const roleName = String(args.role ?? args.name ?? '').trim();
        const role = room.roles.get(roleName);
        if (!role) throw new Error(`Role not found in room: ${roleName}`);
        if (role.exclusive && role.holders.size > 0 && !role.holders.has(caller.name)) {
          throw Object.assign(new Error(`Exclusive role ${roleName} is already held`), {
            status: 409,
          });
        }
        role.holders.add(caller.name);
        return { room_id: room.roomId, role: roleName, holder: caller.name };
      }

      case 'post_message': {
        const roomKey = String(args.room_id ?? 'talentloop-job-search');
        const room = this.roomsById.get(roomKey) ?? this.roomsByName.get(roomKey);
        if (!room) throw new Error(`Room not found: ${roomKey}`);
        const content = String(args.content ?? args.body ?? '');
        return this.appendRoomMessage({
          room,
          senderId: caller.id,
          senderName: caller.name,
          body: content,
          threadId: args.thread_id ? String(args.thread_id) : null,
          attachments: [],
        });
      }

      case 'send_targeted_message': {
        const roomKey = String(args.room_id ?? 'talentloop-job-search');
        const room = this.roomsById.get(roomKey) ?? this.roomsByName.get(roomKey);
        if (!room) throw new Error(`Room not found: ${roomKey}`);
        const target = String(args.target ?? args.recipient ?? '');
        const rawContent = String(args.content ?? args.body ?? '');
        const formatted = rawContent.includes(`@${target}`)
          ? rawContent
          : `@${target} ${rawContent}`;
        return this.appendRoomMessage({
          room,
          senderId: caller.id,
          senderName: caller.name,
          body: formatted,
          threadId: args.thread_id ? String(args.thread_id) : null,
          attachments: [],
          explicitTarget: target,
        });
      }

      case 'read_context': {
        const roomKey = String(args.room_id ?? 'talentloop-job-search');
        const room = this.roomsById.get(roomKey) ?? this.roomsByName.get(roomKey);
        if (!room) throw new Error(`Room not found: ${roomKey}`);
        const limit = Number(args.limit ?? 50);
        return {
          room_id: room.roomId,
          instructions: room.instructions,
          messages: room.messages.slice(-limit),
          documents: [...room.documents.values()],
        };
      }

      case 'create_room_document':
      case 'update_room_document': {
        const roomKey = String(args.room_id ?? 'talentloop-job-search');
        const room = this.roomsById.get(roomKey) ?? this.roomsByName.get(roomKey);
        if (!room) throw new Error(`Room not found: ${roomKey}`);
        const docName = String(args.name ?? '');
        room.documents.set(docName, {
          name: docName,
          description: String(args.description ?? ''),
          instructions: String(args.instructions ?? ''),
          content: String(args.content ?? ''),
          authorAgentId: caller.id,
        });
        return { room_id: room.roomId, document: docName };
      }

      case 'load_internal_documents': {
        const roomKey = String(args.room_id ?? 'talentloop-job-search');
        const room = this.roomsById.get(roomKey) ?? this.roomsByName.get(roomKey);
        if (!room) throw new Error(`Room not found: ${roomKey}`);
        return { documents: [...room.documents.values()] };
      }

      default:
        throw Object.assign(new Error(`Unknown operation: ${operation}`), {
          status: 404,
        });
    }
  }

  private handleWebSocketConnection(
    ws: WebSocket,
    agent: RegisteredSwitchAgent,
    searchParams: URLSearchParams,
  ): void {
    const connectionId = searchParams.get('connection_id');
    if (!connectionId) {
      ws.send(
        JSON.stringify({
          type: 'refused',
          status: 400,
          detail: 'Missing required connection_id query parameter',
        }),
      );
      ws.close(4400, 'Missing connection_id');
      return;
    }

    const scope = (searchParams.get('scope') ?? 'single') as 'single' | 'all';
    const filter = (searchParams.get('filter') ?? 'all') as 'all' | 'addressed';
    const startFrom = searchParams.get('start_from') ?? 'head';
    const expectedGenerationParam = searchParams.get('expected_generation');

    const existing = this.activeConnections.get(connectionId);
    const nextGeneration = existing ? existing.generation + 1 : 1;

    if (
      existing &&
      expectedGenerationParam !== null &&
      Number(expectedGenerationParam) !== existing.generation
    ) {
      ws.send(
        JSON.stringify({
          type: 'refused',
          status: 409,
          detail: 'taken_over',
        }),
      );
      ws.close(4409, 'taken_over');
      return;
    }

    if (existing) {
      clearInterval(existing.pingTimer);
      try {
        existing.ws.send(
          JSON.stringify({
            type: 'evicted',
            code: 'taken_over',
            reason: 'Connection reopened by newer socket',
          }),
        );
        existing.ws.close(1000, 'taken_over');
      } catch {
        // ignore
      }
    }

    const roomsParam = searchParams.get('rooms');
    const claimedRooms = new Set<string>(
      roomsParam
        ? roomsParam
            .split(',')
            .map((r) => r.trim())
            .filter(Boolean)
        : [...this.roomsById.values()]
            .filter((r) => r.participants.has(agent.id) || r.participants.has(agent.name))
            .map((r) => r.roomId),
    );

    const cursor =
      startFrom === 'head'
        ? agent.sequenceCounter
        : Math.max(0, Number.parseInt(startFrom, 10) || 0);

    // Send mandatory every-2-second ping frame per Switch specification
    const pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 2000);
    pingTimer.unref();

    const activeConn: ActiveAgentSocket = {
      connectionId,
      agentId: agent.id,
      agentName: agent.name,
      generation: nextGeneration,
      scope,
      filter,
      rooms: claimedRooms,
      cursor,
      ws,
      lastPongAt: Date.now(),
      pingTimer,
    };

    this.activeConnections.set(connectionId, activeConn);

    // 1. Send connection_state frame first
    const stateFrame: SwitchConnectionStateFrame = {
      type: 'connection_state',
      connection_id: connectionId,
      agent_id: agent.id,
      generation: nextGeneration,
      scope,
      filter,
      spawn_capable: false,
      rooms: [...claimedRooms].sort(),
      cursor,
      protocol: 6,
      heartbeat_interval_seconds: 2,
      server: { version: '0.31.0', contract: [1, 6] },
    };
    ws.send(JSON.stringify(stateFrame));

    // 2. Replay buffered events after cursor if resuming
    if (startFrom !== 'head') {
      for (const evt of agent.eventBuffer) {
        if (evt.id > cursor) {
          ws.send(JSON.stringify(evt));
        }
      }
    }

    ws.on('message', (raw) => {
      try {
        const frame = JSON.parse(raw.toString()) as { type?: string; cursor?: number };
        if (frame.type === 'pong' && typeof frame.cursor === 'number') {
          activeConn.lastPongAt = Date.now();
          if (frame.cursor > activeConn.cursor) {
            activeConn.cursor = frame.cursor;
          }
        }
      } catch {
        // Switch server ignores non-pong frames from clients without error
      }
    });

    ws.on('close', () => {
      clearInterval(pingTimer);
      const current = this.activeConnections.get(connectionId);
      if (current && current.generation === nextGeneration) {
        this.activeConnections.delete(connectionId);
      }
    });
  }

  private appendRoomMessage(params: {
    room: SwitchRoomState;
    senderId: string;
    senderName: string;
    body: string;
    threadId: string | null;
    attachments: SwitchAttachmentPointer[];
    explicitTarget?: string;
  }): { roomId: string; seq: number; messageId: string } {
    const { room, senderId, senderName, body, threadId, attachments, explicitTarget } =
      params;
    room.seqCounter += 1;
    const seq = room.seqCounter;
    const messageId = `msg_${room.name}_${seq}_${crypto.randomUUID().slice(0, 8)}`;
    const timestamp = Date.now();

    room.messages.push({
      seq,
      messageId,
      sender: senderId,
      senderName,
      body,
      threadId,
      attachments,
      timestamp,
    });

    // Deliver to every registered agent in the room
    for (const agent of this.agentsById.values()) {
      if (!room.participants.has(agent.id) && !room.participants.has(agent.name)) {
        continue;
      }
      // Don't mark an agent's own message as addressing itself
      const isSelf = agent.id === senderId || agent.name === senderName;

      // Determine whether this message addresses `agent` by @name, @alias, or @role
      let addressed = false;
      if (!isSelf) {
        const mentionRegex = new RegExp(`@${agent.name}\\b`, 'i');
        if (mentionRegex.test(body) || explicitTarget === agent.name) {
          addressed = true;
        }
        // Check roles held by this agent in the room
        if (!addressed) {
          for (const role of room.roles.values()) {
            if (role.holders.has(agent.name)) {
              const roleRegex = new RegExp(`@${role.name}\\b`, 'i');
              if (roleRegex.test(body)) {
                addressed = true;
                break;
              }
            }
          }
        }
        // If a human user posts in the room without tagging a specific specialist, Milo (the coordinator) is addressed
        const isHumanSender = senderId.startsWith('@switch-user-');
        const mentionsAnyAgent = [...this.agentsByName.keys()].some((name) =>
          new RegExp(`@${name}\\b`, 'i').test(body),
        );
        if (isHumanSender && !mentionsAnyAgent && agent.name === 'milo') {
          addressed = true;
        }
      }

      agent.sequenceCounter += 1;
      const agentSeq = agent.sequenceCounter;

      const envelope: SwitchDomainEventEnvelope<SwitchMessagePayload> = {
        event: 'message',
        data: {
          type: 'message',
          room_id: room.roomId,
          bridge_id: 'slack-bridge-default',
          channel_type: room.channelType,
          payload: {
            addressed,
            sender: senderId,
            sender_name: senderName,
            message_id: messageId,
            body,
            timestamp,
            thread_id: threadId,
            attachments,
          },
          sequence: agentSeq,
        },
        id: agentSeq,
      };

      agent.eventBuffer.push(envelope);
      if (agent.eventBuffer.length > 500) {
        agent.eventBuffer.shift();
      }

      // Push down open WebSockets for this agent
      for (const conn of this.activeConnections.values()) {
        if (conn.agentId !== agent.id) continue;
        if (conn.ws.readyState !== WebSocket.OPEN) continue;
        if (conn.filter === 'addressed' && !addressed) continue;
        conn.ws.send(JSON.stringify(envelope));
      }
    }

    return { roomId: room.roomId, seq, messageId };
  }

  private extractBearer(req: http.IncomingMessage): string | null {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) return null;
    return auth.slice(7).trim();
  }

  private async readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw ? JSON.parse(raw) : {};
  }

  private sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  }
}
