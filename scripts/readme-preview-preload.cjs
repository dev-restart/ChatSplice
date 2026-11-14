/* global require, window */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Electron preloads use CommonJS.
const { contextBridge } = require('electron');
// Static fictional data only. No daemon, IPC, shell or ChatGPT connection.
const workspaceId = 'ws_111111111111111111111111';
const editorId = 'edtab_111111111111111111111111';
const workspaces = ['demo-web', 'demo-design'].map((name, index) => ({
  workspace_id: index === 0 ? workspaceId : 'ws_222222222222222222222222',
  display_name: name,
  root_path: `/demo/${name}`,
  kind: 'user',
}));
const panel = {
  workspace_id: workspaceId,
  console_open: true,
  files_open: true,
  files_width: 280,
  console_height: 220,
};
const tabs = workspaces.map((workspace, index) => ({
  chatgpt_tab_id: index === 0 ? 'tab_111111111111111111111111' : 'tab_222222222222222222222222',
  workspace_id: workspace.workspace_id,
  label: `${workspace.display_name} · ChatGPT Project`,
  project_instructions_confirmed: true,
  active: index === 0,
}));
const tabList = { tabs, active_tab_id: tabs[0].chatgpt_tab_id };
const content = `import { useState } from 'react';\n\n// Fictional example for the public product preview.\nexport function WelcomeCard() {\n  const [count, setCount] = useState(0);\n\n  return (\n    <section className="welcome-card">\n      <span className="eyebrow">DEMO WORKSPACE</span>\n      <h1>Build something of your own.</h1>\n      <p>ChatGPT reasons. Your local tools do the work.</p>\n      <button onClick={() => setCount(count + 1)}>\n        Explore the demo · {count}\n      </button>\n    </section>\n  );\n}\n`;
const editorTab = {
  editor_tab_id: editorId,
  workspace_id: workspaceId,
  path: 'src/WelcomeCard.tsx',
  label: 'WelcomeCard.tsx',
  dirty: false,
  draft_revision: 0,
  loaded: true,
};
const editorState = {
  workspace_id: workspaceId,
  tabs: [editorTab],
  active_editor_tab_id: editorId,
  open_document_ids: [editorId],
  revision: 1,
};
const terminal = {
  terminal_id: 'term_111111111111111111111111',
  workspace_id: workspaceId,
  label: 'demo-web',
  state: 'shellrunning',
  cols: 100,
  rows: 14,
  sequence: 1,
};
const bridge = {
  getStatus: async () => ({
    daemon: {
      protocol_version: 4,
      healthy: true,
      ready: true,
      mcp_url: null,
      workspace_count: 2,
      latest_direct_edits: [],
      latest_mcp_activities: [],
      execution_jobs: [],
      read_only_mode: false,
      auto_attach_workspace_ids: [],
      mcp_app_name: 'ChatSplice MCP',
      tunnel: { state: 'stopped', ready: false, configuration: null, error_code: null },
    },
    chatgpt_login_confirmed: false,
    credential_store: { available: true, configured: false, error_code: null },
  }),
  listWorkspaces: async () => ({ workspaces, count: 2 }),
  listWorkspaceReferences: async () => ({ references: [], count: 0 }),
  listChatGptTabs: async () => tabList,
  getSidebarLayout: async () => ({ width: 280, collapsed: false }),
  getPanelState: async () => panel,
  setModalOverlay: async () => undefined,
  automateProjectInstructionsUpdate: async () => ({ state: 'skipped', reason: 'editor_active' }),
  getEditorState: async () => editorState,
  getEditorDocument: async () => ({ ...editorTab, content, sha256: '0'.repeat(64) }),
  listWorkspaceFiles: async ({ path }) => ({
    workspace_id: workspaceId,
    path,
    has_more: false,
    next_offset: null,
    entries: (path === 'src'
      ? [
          ['WelcomeCard.tsx', 'file'],
          ['styles.css', 'file'],
        ]
      : [
          ['src', 'directory'],
          ['public', 'directory'],
          ['package.json', 'file'],
          ['README.md', 'file'],
        ]
    ).map(([name, type]) => ({ name, path: path === '.' ? name : `${path}/${name}`, type })),
  }),
  listTerminalSessions: async () => [terminal],
  readTerminalSession: async ({ after_sequence }) => ({
    ...terminal,
    replay_truncated: false,
    output:
      after_sequence === 1
        ? ''
        : '\u001b[36mdemo-web\u001b[0m % pnpm test\r\n\r\n \u001b[32m✓\u001b[0m WelcomeCard.test.tsx  (3 tests)\r\n\r\n Test Files  \u001b[32m1 passed\u001b[0m\r\n      Tests  \u001b[32m3 passed\u001b[0m\r\n\r\ndemo-web % ',
  }),
  resizeTerminalSession: async () => undefined,
};
contextBridge.exposeInMainWorld('chatsplice', Object.freeze(bridge));
window.localStorage.setItem('chatsplice.ui-locale.v1', 'ko');
window.localStorage.setItem('chatsplice.appearance.v1', 'dark');
