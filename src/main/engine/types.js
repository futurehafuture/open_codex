'use strict';

/**
 * Normalized engine event contract.
 *
 * Both the SDK adapter (`@openai/codex-sdk`, dotted event names) and the
 * app-server adapter (`codex app-server`, slashed JSON-RPC methods) emit events
 * in THIS shape, so the renderer never has to know which engine is active.
 *
 * @typedef {Object} NormalizedItem
 * @property {string} id
 * @property {'agent_message'|'reasoning'|'command_execution'|'file_change'|'mcp_tool_call'|'web_search'|'todo_list'|'error'} type
 * @property {string} [text]                      agent_message / reasoning / error
 * @property {string} [command]                   command_execution
 * @property {string} [aggregatedOutput]          command_execution
 * @property {number} [exitCode]                  command_execution
 * @property {Array<{path:string,kind:string}>} [changes] file_change
 * @property {Array<{text:string,completed:boolean}>} [items] todo_list
 * @property {string} [query]                     web_search
 * @property {'in_progress'|'completed'|'failed'|'declined'} [status]
 *
 * @typedef {Object} EngineEvent
 * @property {'thread_started'|'turn_started'|'item'|'turn_completed'|'turn_failed'|'approval_request'|'error'} kind
 * @property {string} [sessionId]   local session id this event belongs to
 * @property {string} [threadId]    engine thread id (resume key)
 * @property {'started'|'updated'|'completed'} [phase]  for kind === 'item'
 * @property {NormalizedItem} [item]
 * @property {Object} [usage]
 * @property {string} [message]
 * @property {Object} [approval]    for kind === 'approval_request'
 */

/** @enum {string} */
const EngineMode = Object.freeze({
  SDK: 'sdk',
  APP_SERVER: 'app-server',
});

/** Approval decisions understood by the app-server protocol. */
const ApprovalDecision = Object.freeze({
  ACCEPT: 'accept',
  ACCEPT_FOR_SESSION: 'acceptForSession',
  DECLINE: 'decline',
  CANCEL: 'cancel',
});

module.exports = { EngineMode, ApprovalDecision };
