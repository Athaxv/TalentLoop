import { dbRepo } from '../db';
import type { AgentId, AgentTaskRecord, TaskLifecycleStatus } from '../db/schema';
import { AGENT_TEAM_REGISTRY } from '../agents/registry';
import {
  DelegatedTaskEnvelopeSchema,
  type CandidateContext,
  type DelegatedTaskEnvelope,
} from '../agents/contracts';
import {
  SwitchAgentWebSocketConnection,
  SwitchHttpClient,
  type SwitchAttachmentPointer,
  type SwitchDomainEventEnvelope,
  type SwitchMessagePayload,
} from './protocol-client';
import { LocalSwitchProtocolServer } from './local-switch-server';
import { slackClient } from '../slack/client';

export type SwitchAgentMessageHandler = (params: {
  agentId: AgentId;
  roomId: string;
  sequence: number;
  message: SwitchMessagePayload;
  parsedTaskEnvelope?: DelegatedTaskEnvelope;
}) => Promise<void>;

const TASK_ENVELOPE_TAG_RE = /```switch-task-json\s*([\s\S]*?)```/i;

/**
 * Central Switch Coordination Manager for TalentLoop.
 * Manages:
 * 1. Switch Server connection (external Switch Core or embedded Switch Protocol Server)
 * 2. Registration of all 6 agents (`milo`, `wally`, `inky`, `scout`, `clover`, `pip`) via `POST /agents`
 * 3. Creation & configuration of the `talentloop-job-search` Switch room, roles, and room documents
 * 4. Persistent WebSocket connections for all 6 agents (`GET /agents/{id}/connection/ws`)
 * 5. Agent-to-agent task delegation and progress reporting over Switch (`send_targeted_message` & `post_message`)
 */
export class SwitchCoordinator {
  private httpClient: SwitchHttpClient | null = null;
  private localServer: LocalSwitchProtocolServer | null = null;
  private wsConnections = new Map<AgentId, SwitchAgentWebSocketConnection>();
  private messageHandlers = new Map<AgentId, SwitchAgentMessageHandler>();
  private roomId: string | null = null;
  private readonly roomName: string;
  private initialized = false;
  private initializingPromise: Promise<void> | null = null;

  constructor() {
    this.roomName = process.env.SWITCH_ROOM_NAME?.trim() || 'talentloop-job-search';
  }

  public registerAgentHandler(
    agentId: AgentId,
    handler: SwitchAgentMessageHandler,
  ): void {
    this.messageHandlers.set(agentId, handler);
  }

  public isInitialized(): boolean {
    return this.initialized;
  }

  public getRoomId(): string {
    return this.roomId ?? `!room-${this.roomName}:talentloop.local`;
  }

  public getServerUrl(): string {
    return this.httpClient?.getServerUrl() ?? 'http://127.0.0.1:8400';
  }

  public async ensureInitialized(): Promise<{
    serverUrl: string;
    roomId: string;
    agentsOnline: AgentId[];
  }> {
    if (this.initialized && this.httpClient && this.roomId) {
      return {
        serverUrl: this.httpClient.getServerUrl(),
        roomId: this.roomId,
        agentsOnline: [...this.wsConnections.keys()],
      };
    }

    if (this.initializingPromise) {
      await this.initializingPromise;
      return {
        serverUrl: this.httpClient!.getServerUrl(),
        roomId: this.roomId!,
        agentsOnline: [...this.wsConnections.keys()],
      };
    }

    this.initializingPromise = this.initializeInternal();
    try {
      await this.initializingPromise;
    } finally {
      this.initializingPromise = null;
    }

    return {
      serverUrl: this.httpClient!.getServerUrl(),
      roomId: this.roomId!,
      agentsOnline: [...this.wsConnections.keys()],
    };
  }

  private async initializeInternal(): Promise<void> {
    const registrationToken =
      process.env.AGENT_REGISTRATION_TOKEN?.trim() ||
      'switch_reg_bootstrap_token_talentloop_2026';
    const configuredUrl =
      process.env.SWITCH_SERVER_URL?.trim() || 'http://127.0.0.1:8400';

    let probeClient = new SwitchHttpClient(configuredUrl);
    const probe = await probeClient.probeHealth();

    if (!probe.ok) {
      // Spin up the local Switch Protocol Server speaking the exact Switch wire protocol
      const portMatch = configuredUrl.match(/:(\d+)/);
      const port = portMatch ? Number(portMatch[1]) : 8400;
      this.localServer = new LocalSwitchProtocolServer(port, registrationToken);
      const activeUrl = await this.localServer.start();
      probeClient = new SwitchHttpClient(activeUrl);
    }

    this.httpClient = probeClient;

    const agentIds: AgentId[] = ['milo', 'wally', 'inky', 'scout', 'clover', 'pip'];

    // Step 1: Register all 6 agents with Switch and configure their addressing policies
    for (const agentId of agentIds) {
      const def = AGENT_TEAM_REGISTRY[agentId];
      const dbAgent = dbRepo.getAgent(agentId);

      const reg = await this.httpClient.registerAgent(registrationToken, {
        name: def.id,
        display_name: def.displayName,
        description: def.description,
        connector_type: 'talentloop-agent',
        integration_profile: {
          connection_model: 'always_on',
          message_exchange: true,
          pre_invocation_mediation: [],
          post_invocation_mediation: [],
          event_reporting: [],
        },
        overwrite: true,
      });

      await this.httpClient.updateAddressing({
        switchAgentId: reg.id,
        agentApiKey: reg.api_key,
        addressing: def.addressingPolicy,
      });

      dbRepo.updateAgentSwitchRegistration(agentId, {
        switchAgentId: reg.id,
        switchApiKey: reg.api_key,
        switchConnectionId: dbAgent.switchConnectionId,
        status: 'ONLINE',
      });
    }

    // Step 2: Milo creates the `talentloop-job-search` room and invites all specialist agents
    const miloRecord = dbRepo.getAgent('milo');
    const createdRoom = await this.httpClient.callOperation<{
      room_id: string;
      name: string;
    }>({
      switchAgentId: miloRecord.switchAgentId!,
      agentApiKey: miloRecord.switchApiKey!,
      connectionId: miloRecord.switchConnectionId,
      operation: 'create_room',
      args: {
        name: this.roomName,
        description:
          'TalentLoop multi-agent job search, application automation, and founder outreach room',
        channel_type: 'channel_public',
        instructions:
          'TalentLoop shared Switch room. Users talk to @milo. @milo delegates tasks to @scout, @wally, @inky, @clover, and @pip. External actions require human approval.',
      },
    });

    this.roomId = createdRoom.room_id;

    // Invite all specialist agents and define roles
    for (const agentId of agentIds) {
      const def = AGENT_TEAM_REGISTRY[agentId];
      if (agentId !== 'milo') {
        await this.httpClient.callOperation({
          switchAgentId: miloRecord.switchAgentId!,
          agentApiKey: miloRecord.switchApiKey!,
          connectionId: miloRecord.switchConnectionId,
          operation: 'invite_agent_to_room',
          args: {
            room_id: this.roomId,
            agent_name: agentId,
          },
        });
      }

      await this.httpClient.callOperation({
        switchAgentId: miloRecord.switchAgentId!,
        agentApiKey: miloRecord.switchApiKey!,
        connectionId: miloRecord.switchConnectionId,
        operation: 'define_role',
        args: {
          room_id: this.roomId,
          name: def.switchRoleName,
          instructions: def.systemInstructions,
          exclusive: agentId !== 'scout' && agentId !== 'clover',
        },
      });
    }

    // Create shared room protocol document
    await this.httpClient.callOperation({
      switchAgentId: miloRecord.switchAgentId!,
      agentApiKey: miloRecord.switchApiKey!,
      connectionId: miloRecord.switchConnectionId,
      operation: 'create_room_document',
      args: {
        room_id: this.roomId,
        name: 'workflow-protocol',
        description: 'TalentLoop Switch Handoff & Approval Protocol',
        instructions: 'Follow this contract for all task handoffs and human approvals.',
        content:
          '1. Users address @milo.\n2. @milo delegates structured tasks via send_targeted_message.\n3. @wally, @inky, and @pip require explicit human approval before external submissions or emails.',
      },
    });

    // Step 3: Open WebSocket connections for all 6 agents, claim the room, and assume roles
    for (const agentId of agentIds) {
      const def = AGENT_TEAM_REGISTRY[agentId];
      const agentRec = dbRepo.getAgent(agentId);

      const wsConn = new SwitchAgentWebSocketConnection({
        agentKey: agentId,
        switchAgentId: agentRec.switchAgentId!,
        agentApiKey: agentRec.switchApiKey!,
        connectionId: agentRec.switchConnectionId,
        httpBaseUrl: this.httpClient.getServerUrl(),
        onState: (stateFrame) => {
          dbRepo.updateAgentSwitchRegistration(agentId, {
            switchGeneration: stateFrame.generation,
            switchCursor: stateFrame.cursor,
            switchRoomId: this.roomId!,
            status: 'IDLE',
          });
        },
        onEvent: async (envelope) => {
          await this.handleAgentSwitchEvent(agentId, envelope);
        },
      });

      await wsConn.connect([this.roomId]);
      this.wsConnections.set(agentId, wsConn);

      // Claim room context and assume role
      await this.httpClient.callOperation({
        switchAgentId: agentRec.switchAgentId!,
        agentApiKey: agentRec.switchApiKey!,
        connectionId: agentRec.switchConnectionId,
        operation: 'connect_to_room',
        args: { room_id: this.roomId },
      });

      await this.httpClient.callOperation({
        switchAgentId: agentRec.switchAgentId!,
        agentApiKey: agentRec.switchApiKey!,
        connectionId: agentRec.switchConnectionId,
        operation: 'assume_role',
        args: { room_id: this.roomId, role: def.switchRoleName },
      });

      dbRepo.logAgentEvent({
        agentId,
        eventType: 'SWITCH_CONNECTED',
        switchRoomId: this.roomId,
        summary: `${def.displayName} connected to Switch room ${this.roomName} and assumed role @${def.switchRoleName}`,
        payload: {
          switchAgentId: agentRec.switchAgentId,
          connectionId: agentRec.switchConnectionId,
          role: def.switchRoleName,
        },
      });
    }

    this.initialized = true;
  }

  private async handleAgentSwitchEvent(
    agentId: AgentId,
    envelope: SwitchDomainEventEnvelope,
  ): Promise<void> {
    dbRepo.updateAgentSwitchRegistration(agentId, {
      switchCursor: envelope.id,
    });

    if (envelope.event !== 'message') return;
    const message = envelope.data.payload as SwitchMessagePayload;

    // Act only when addressed (per Switch Agent Protocol step 9: "Act on a message event only when its payload.addressed is true")
    if (!message.addressed) return;

    let parsedEnvelope: DelegatedTaskEnvelope | undefined;
    const match = message.body.match(TASK_ENVELOPE_TAG_RE);
    if (match?.[1]) {
      try {
        const rawJson = JSON.parse(match[1].trim());
        const validated = DelegatedTaskEnvelopeSchema.safeParse(rawJson);
        if (validated.success && validated.data.assignedAgent === agentId) {
          parsedEnvelope = validated.data;
        }
      } catch {
        // Not a task JSON block or invalid JSON
      }
    }

    dbRepo.logAgentEvent({
      workflowId: parsedEnvelope?.workflowId ?? null,
      taskId: parsedEnvelope?.taskId ?? null,
      agentId,
      eventType: 'SWITCH_MESSAGE_RECEIVED',
      switchSequence: envelope.id,
      switchRoomId: envelope.data.room_id,
      summary: `@${agentId} received Switch message from ${message.sender_name}: ${message.body
        .split('\n')[0]
        .slice(0, 120)}`,
      payload: {
        messageId: message.message_id,
        sender: message.sender,
        senderName: message.sender_name,
        threadId: message.thread_id,
        hasTaskEnvelope: Boolean(parsedEnvelope),
      },
    });

    const handler = this.messageHandlers.get(agentId);
    if (handler) {
      await handler({
        agentId,
        roomId: envelope.data.room_id,
        sequence: envelope.id,
        message,
        parsedTaskEnvelope: parsedEnvelope,
      });
    }
  }

  /**
   * Posts a message from an agent into the Switch room (`post_message` or `send_targeted_message`)
   * and mirrors it to Slack for full visibility.
   */
  public async postAgentRoomMessage(params: {
    fromAgent: AgentId;
    targetAgentOrUser?: string;
    content: string;
    workflowId?: string | null;
    taskId?: string | null;
    threadId?: string | null;
    slackChannelId?: string | null;
    slackBlocks?: unknown[];
  }): Promise<{ messageId: string; seq: number }> {
    await this.ensureInitialized();
    const agentRec = dbRepo.getAgent(params.fromAgent);

    const opName = params.targetAgentOrUser ? 'send_targeted_message' : 'post_message';
    const result = await this.httpClient!.callOperation<{
      roomId: string;
      seq: number;
      messageId: string;
    }>({
      switchAgentId: agentRec.switchAgentId!,
      agentApiKey: agentRec.switchApiKey!,
      connectionId: agentRec.switchConnectionId,
      operation: opName,
      args: {
        room_id: this.roomId!,
        ...(params.targetAgentOrUser ? { target: params.targetAgentOrUser } : {}),
        content: params.content,
        ...(params.threadId ? { thread_id: params.threadId } : {}),
      },
    });

    // Resolve the workflow's Slack channel so every agent reply lands in the user's active channel!
    const wf = params.workflowId ? dbRepo.getWorkflow(params.workflowId) : null;
    const resolvedSlackChannel =
      params.slackChannelId || wf?.slackChannelId || undefined;

    // Mirror human-readable message to Slack (skip verbose raw task JSON envelopes & internal status echoes for agents that manage their own live-updating Slack cards)
    const isInternalSpecialistEcho =
      (params.fromAgent === 'wally' ||
        params.fromAgent === 'inky' ||
        params.fromAgent === 'scout' ||
        params.fromAgent === 'clover') &&
      /\[(IN_PROGRESS|COMPLETED|FAILED)\]/.test(params.content);
    const isInternalTaskHandoff = params.content.includes('```switch-task-json');

    const displayContent = params.content.replace(TASK_ENVELOPE_TAG_RE, '').trim();
    if (displayContent && !isInternalSpecialistEcho && !isInternalTaskHandoff) {
      await slackClient.postAgentMessage({
        agentId: params.fromAgent,
        text: displayContent,
        channel: resolvedSlackChannel,
        threadTs: params.threadId,
        blocks: params.slackBlocks,
      });
    }

    dbRepo.logAgentEvent({
      workflowId: params.workflowId ?? null,
      taskId: params.taskId ?? null,
      agentId: params.fromAgent,
      eventType: 'SWITCH_MESSAGE_POSTED',
      switchSequence: result.seq,
      switchRoomId: this.roomId,
      summary: `@${params.fromAgent} posted to Switch room: ${displayContent
        .split('\n')[0]
        .slice(0, 120)}`,
      payload: {
        operation: opName,
        target: params.targetAgentOrUser ?? null,
        messageId: result.messageId,
      },
    });

    return result;
  }

  /**
   * Delegates a structured task from Milo (or another coordinator) to a specialist agent over Switch.
   */
  public async delegateTaskOverSwitch(params: {
    workflowId: string;
    requestingAgent: AgentId;
    assignedAgent: AgentId;
    userId: string;
    taskType: string;
    input: unknown;
    candidateContext: CandidateContext;
    expectedOutput: string;
    humanSummary: string;
    threadId?: string | null;
  }): Promise<AgentTaskRecord> {
    await this.ensureInitialized();

    const taskRecord = dbRepo.createAgentTask({
      workflowId: params.workflowId,
      requestingAgent: params.requestingAgent,
      assignedAgent: params.assignedAgent,
      userId: params.userId,
      taskType: params.taskType,
      input: params.input,
      candidateContext: params.candidateContext,
      expectedOutput: params.expectedOutput,
    });

    const envelope: DelegatedTaskEnvelope = {
      taskId: taskRecord.taskId,
      workflowId: taskRecord.workflowId,
      requestingAgent: taskRecord.requestingAgent,
      assignedAgent: taskRecord.assignedAgent,
      userId: taskRecord.userId,
      taskType: taskRecord.taskType,
      input: params.input,
      candidateContext: params.candidateContext,
      expectedOutput: params.expectedOutput,
      status: 'ACCEPTED',
      createdAt: taskRecord.createdAt,
      updatedAt: taskRecord.updatedAt,
      result: null,
      error: null,
    };

    const messageContent = `@${params.assignedAgent} ${params.humanSummary} (Task \`${taskRecord.taskId}\` · Type \`${params.taskType}\`)\n\`\`\`switch-task-json\n${JSON.stringify(
      envelope,
    )}\n\`\`\``;

    await this.postAgentRoomMessage({
      fromAgent: params.requestingAgent,
      targetAgentOrUser: params.assignedAgent,
      content: messageContent,
      workflowId: params.workflowId,
      taskId: taskRecord.taskId,
      threadId: params.threadId,
    });

    return taskRecord;
  }

  /**
   * Reports task lifecycle state (ACCEPTED, IN_PROGRESS, REQUIRES_APPROVAL, COMPLETED, FAILED)
   * from a specialist agent back to @milo over the Switch room.
   */
  public async reportTaskStatusOverSwitch(params: {
    taskId: string;
    agentId: AgentId;
    status: TaskLifecycleStatus;
    summaryMessage: string;
    result?: unknown;
    errorText?: string | null;
    threadId?: string | null;
  }): Promise<AgentTaskRecord> {
    await this.ensureInitialized();

    const currentTask = dbRepo.getAgentTask(params.taskId);
    if (!currentTask) throw new Error(`AgentTask not found: ${params.taskId}`);

    const statusBadge: Record<TaskLifecycleStatus, string> = {
      ACCEPTED: '🟢 [ACCEPTED]',
      IN_PROGRESS: '🔄 [IN_PROGRESS]',
      REQUIRES_APPROVAL: '⏸️ [REQUIRES_HUMAN_APPROVAL]',
      COMPLETED: '✅ [COMPLETED]',
      FAILED: '❌ [FAILED]',
    };

    await this.postAgentRoomMessage({
      fromAgent: params.agentId,
      targetAgentOrUser: currentTask.requestingAgent,
      content: `@${currentTask.requestingAgent} ${statusBadge[params.status]} Task \`${params.taskId}\` (${currentTask.taskType}): ${params.summaryMessage}`,
      workflowId: currentTask.workflowId,
      taskId: params.taskId,
      threadId: params.threadId,
    });

    const updatedTask = dbRepo.updateAgentTaskStatus(params.taskId, params.status, {
      result: params.result,
      errorText: params.errorText,
    });

    dbRepo.updateAgentSwitchRegistration(params.agentId, {
      status: params.status === 'IN_PROGRESS' ? 'BUSY' : 'IDLE',
      currentTaskId: params.status === 'IN_PROGRESS' ? params.taskId : null,
    });

    return updatedTask;
  }

  /**
   * Relays an inbound Slack user message into the Switch room so whichever agent(s) are addressed
   * receive `payload.addressed = true` over their Switch WebSocket connection.
   */
  public async relayInboundSlackMessage(params: {
    slackUserId: string;
    slackUserName: string;
    text: string;
    threadTs?: string | null;
    attachments?: SwitchAttachmentPointer[];
  }): Promise<{ roomId: string; seq: number; messageId: string }> {
    await this.ensureInitialized();

    if (this.localServer) {
      return this.localServer.postHumanBridgeMessage({
        roomNameOrId: this.roomId!,
        slackUserId: params.slackUserId,
        slackUserName: params.slackUserName,
        body: params.text,
        threadId: params.threadTs ?? null,
        attachments: params.attachments ?? [],
      });
    }

    // Even if this.localServer is in another module context after hot-reload, call POST /bridge/human-message over HTTP!
    const res = await fetch(`${this.httpClient!.getServerUrl()}/bridge/human-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room_id: this.roomId!,
        slack_user_id: params.slackUserId,
        slack_user_name: params.slackUserName,
        body: params.text,
        thread_id: params.threadTs ?? null,
        attachments: params.attachments ?? [],
      }),
    });

    if (res.ok) {
      return (await res.json()) as { roomId: string; seq: number; messageId: string };
    }

    const milo = dbRepo.getAgent('milo');
    return this.httpClient!.callOperation({
      switchAgentId: milo.switchAgentId!,
      agentApiKey: milo.switchApiKey!,
      connectionId: milo.switchConnectionId,
      operation: 'post_message',
      args: {
        room_id: this.roomId!,
        content: `[Slack user ${params.slackUserName} (${params.slackUserId})]: ${params.text}`,
      },
    });
  }

  /**
   * Provisions a dedicated Switch Room for a user once they finish onboarding
   * and invites all 6 specialist agents (`milo`, `wally`, `inky`, `scout`, `clover`, `pip`).
   */
  public async provisionUserSwitchRoom(params: {
    roomName: string;
    userFullName: string;
  }): Promise<string> {
    await this.ensureInitialized();
    const miloRecord = dbRepo.getAgent('milo');
    const created = await this.httpClient!.callOperation<{
      room_id: string;
      name: string;
    }>({
      switchAgentId: miloRecord.switchAgentId!,
      agentApiKey: miloRecord.switchApiKey!,
      connectionId: miloRecord.switchConnectionId,
      operation: 'create_room',
      args: {
        name: params.roomName,
        description: `Personal TalentLoop Switch room for ${params.userFullName}`,
        channel_type: 'channel_public',
        instructions: `Dedicated job search room for ${params.userFullName}. Coordinate @scout, @wally, @inky, @clover, and @pip.`,
      },
    });

    const specialists: AgentId[] = ['wally', 'inky', 'scout', 'clover', 'pip'];
    for (const agId of specialists) {
      await this.httpClient!.callOperation({
        switchAgentId: miloRecord.switchAgentId!,
        agentApiKey: miloRecord.switchApiKey!,
        connectionId: miloRecord.switchConnectionId,
        operation: 'invite_agent_to_room',
        args: {
          room_id: created.room_id,
          agent_name: agId,
        },
      });
    }

    return created.room_id;
  }

  public getRoomTranscript(): Array<{
    seq: number;
    messageId: string;
    sender: string;
    senderName: string;
    body: string;
    threadId: string | null;
    timestamp: number;
  }> {
    if (this.localServer && this.roomId) {
      return this.localServer.getRoomTranscript(this.roomId);
    }
    return [];
  }

  public async shutdown(): Promise<void> {
    for (const conn of this.wsConnections.values()) {
      conn.close();
    }
    this.wsConnections.clear();
    if (this.localServer) {
      await this.localServer.stop();
      this.localServer = null;
    }
    this.initialized = false;
  }
}

const globalForSwitch = globalThis as unknown as {
  __talentLoopSwitchCoordinator?: SwitchCoordinator;
};

if (globalForSwitch.__talentLoopSwitchCoordinator) {
  Object.setPrototypeOf(
    globalForSwitch.__talentLoopSwitchCoordinator,
    SwitchCoordinator.prototype,
  );
}

export const switchCoordinator =
  globalForSwitch.__talentLoopSwitchCoordinator ??
  (globalForSwitch.__talentLoopSwitchCoordinator = new SwitchCoordinator());
