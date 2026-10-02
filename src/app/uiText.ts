export type UiLanguage = 'en' | 'zh'

export const UI_LANGUAGE_STORAGE = 'flowm.language'

const en = {
  model: {
    label: 'Model',
    select: 'Select a model',
    accountCatalog: 'From your GPT account',
    apiCatalog: 'OpenAI API models',
    gatewayCatalog: 'From your gateway',
    unavailable: 'Unavailable',
    loading: 'Loading available models…',
    refresh: 'Refresh models',
    loadFailed: 'Could not load this connection’s models. Refresh to retry.',
  },
  harness: {
    title: 'Model interface',
    gptLogin: 'GPT sign in',
    claudeLogin: 'Claude sign in',
    gptDescription: 'Connect your ChatGPT account',
    claudeDescription: 'Connect your Claude account',
    gatewayDescription: 'Connect a model gateway',
    gatewayModels: 'After connecting, choose a model returned by the gateway.',
    claudeUnavailable: 'Claude account sign-in is not available yet. Connect Claude through Gateway.',
    connect: 'Connect',
    connecting: 'Connecting…',
    provider: 'Provider',
    name: 'Connection name',
    url: 'Gateway base URL',
    authentication: 'Authentication',
    noAuthentication: 'No authentication',
    tokenPlaceholder: 'Enter a token, or leave empty to keep the saved token',
    connected: 'Connected',
    notConnected: 'Not connected',
    addProfile: 'Add connection',
    save: 'Save',
    login: 'Continue with ChatGPT',
    logout: 'Sign out',
    loginPending: 'Complete sign-in in your browser, then return to FlowM.',
    configureFirst: 'Configure a model connection in Settings first',
    cancelledQuestion: 'This request has ended',
  },
  activity: {
    aria: 'Workspace views',
    labels: {
      files: 'Explorer',
      search: 'Search',
      git: 'Source Control',
    },
  },
  app: {
    emptyPanel: 'No content',
    hidePanel: 'Hide panel',
    placeholderReady: 'Describe what to change... (Enter to send)',
    openProjectFirst: 'Open a project from Explorer first',
    desktopOnly: 'Open FlowM in its desktop application.',
  },
  chat: {
    assistant: 'Canvas Assistant',
    activityComplete: 'Worked',
    activityDiagnostics: 'Diagnostics',
    activityFailed: 'Stopped with an error',
    activityStopped: 'Stopped',
    activityRanAction: 'Ran {count} action',
    activityRanActions: 'Ran {count} actions',
    activityThinking: 'Thinking',
    activityTool: 'tool',
    activityTools: 'tools',
    activityWorking: 'Working...',
    debugRequest: 'Request sent to the model',
    debugRequestWithImage: 'Request sent to the model (with image)',
    debugImageAlt: 'Canvas thumbnail sent to the model',
    hint: 'Place or sketch shapes on the canvas, select them, then describe what you want here. The model can edit the canvas directly.',
    loadProject: 'Load',
    saveProject: 'Save',
    selectAssistant: 'Select canvas assistant',
    send: 'Send',
    stop: 'Stop',
    settings: 'Settings',
    settingsTitle: 'Settings (model connections)',
    steps: 'steps',
    questionAnswered: 'Answered: {answer}',
    questionInputDisabled: 'Answer the assistant question above to continue',
    questionNo: 'No',
    questionOther: 'Other',
    questionOtherPlaceholder: 'Type a different answer...',
    questionSendOther: 'Send',
    questionTitle: 'Assistant needs confirmation',
    questionYes: 'Yes',
    systemCanvasOps: 'Applied {applied}/{total} canvas operations',
    systemCodexDone: '✓ Codex done',
    systemCodexError: 'Codex error: {message}',
    systemCodexStarted: 'Codex started',
    systemDone: '✓ Done · {turns} turns · {cost}',
    systemEmptyError: '(empty error)',
    systemError: 'Error: {message}',
    systemToolComplete: '  ↳ Tool completed',
    systemToolError: '  ↳ Tool error',
  },
  common: {
    cancel: 'Cancel',
    delete: 'Delete',
    done: 'Done',
    empty: 'Empty',
    expand: 'Expand',
    fold: 'Fold',
  },
  engineLabels: {
    'canvas-harness': 'Canvas Assistant',
    'project-harness': 'Project Agent',
  },
  file: {
    noProject: 'No project open',
    openProject: 'Open Project',
    openProjectHint: 'Select the project code folder',
    openProjectPrompt: 'Use Open Project above to choose a code folder',
    save: 'Save',
  },
  git: {
    changes: 'Changes',
    diff: 'Diff',
    emptyChanges: 'No changes',
    emptyGraph: 'No commits',
    graph: 'Graph',
    loading: 'Loading...',
    loadingDiff: 'Loading diff...',
    loadingGraph: 'Loading graph...',
    noDiff: 'No diff',
    openProjectPrompt: 'Open a project to view Git status.',
    refresh: 'Refresh',
    selectFile: 'Select a file to view diff',
  },
  language: {
    label: 'Language',
    options: {
      en: 'English',
      zh: '中文',
    },
  },
  picker: {
    delete: 'Delete',
    history: 'History / switch',
    noMatch: 'No matches',
    rename: 'Rename',
    renameHint: 'Double-click to rename',
    search: 'Search...',
  },
  settings: {
    title: 'Settings',
  },
  workspace: {
    deleteCanvasMessage: 'Delete canvas "{name}"? Its content will be deleted too.',
    deleteCanvasTitle: 'Delete canvas',
    deleteSessionMessage: 'Delete conversation "{name}"? This cannot be undone.',
    deleteSessionTitle: 'Delete conversation',
    newCanvas: 'New canvas',
    newSession: 'New conversation',
    noCanvas: 'No canvas',
    noProject: 'No project open',
    noSession: 'No conversation',
  },
}

export type UiText = typeof en

const zh: UiText = {
  harness: {
    title: '大模型接口',
    gptLogin: 'GPT 登录',
    claudeLogin: 'Claude 登录',
    gptDescription: '连接 ChatGPT 账号',
    claudeDescription: '连接 Claude 账号',
    gatewayDescription: '连接模型网关',
    gatewayModels: '连接后，从网关返回的列表中选择模型。',
    claudeUnavailable: 'Claude 账号登录尚未开放，可通过 Gateway 连接 Claude。',
    connect: '连接',
    connecting: '正在连接…',
    provider: '服务商',
    name: '连接名称',
    url: 'Gateway 地址',
    authentication: '认证方式',
    noAuthentication: '无需认证',
    tokenPlaceholder: '输入 token，留空保留已有凭据',
    connected: '已连接',
    notConnected: '尚未连接',
    addProfile: '添加连接',
    save: '保存',
    login: 'Continue with ChatGPT',
    logout: '退出登录',
    loginPending: '请在浏览器完成登录，再返回 FlowM。',
    configureFirst: '先在设置中配置模型连接',
    cancelledQuestion: '此请求已结束',
  },
  model: {
    label: '模型',
    select: '选择模型',
    accountCatalog: '来自当前 GPT 账号',
    apiCatalog: 'OpenAI API 模型',
    gatewayCatalog: '来自 Gateway',
    unavailable: '不可用',
    loading: '正在读取可用模型…',
    refresh: '刷新模型列表',
    loadFailed: '当前连接的模型列表读取失败，请刷新重试。',
  },
  activity: {
    aria: '工作区视图',
    labels: {
      files: '资源管理器',
      search: '搜索',
      git: '源代码管理',
    },
  },
  app: {
    emptyPanel: '暂无内容',
    hidePanel: '隐藏侧栏',
    placeholderReady: '描述需求…（Enter 发送）',
    openProjectFirst: '请先从资源管理器打开工程',
    desktopOnly: '请通过 FlowM 桌面应用打开。',
  },
  chat: {
    assistant: '画布助手',
    activityComplete: '已处理',
    activityDiagnostics: '诊断信息',
    activityFailed: '处理出错',
    activityStopped: '已停止',
    activityRanAction: '执行了 {count} 项操作',
    activityRanActions: '执行了 {count} 项操作',
    activityThinking: '思考过程',
    activityTool: '个工具',
    activityTools: '个工具',
    activityWorking: '处理中...',
    debugRequest: '发送给模型的请求',
    debugRequestWithImage: '发送给模型的请求（含图片）',
    debugImageAlt: '发送给模型的画布缩略图',
    hint: '在画布上放置或手绘图形，选中后在这里向模型描述需求；模型可直接修改画布。',
    loadProject: '加载',
    saveProject: '保存',
    selectAssistant: '选择画布助手',
    send: '发送',
    stop: '停止',
    settings: '设置',
    settingsTitle: '设置（模型连接）',
    steps: '步',
    questionAnswered: '已回答：{answer}',
    questionInputDisabled: '请先回答上方助手问题',
    questionNo: '否',
    questionOther: '其他',
    questionOtherPlaceholder: '输入其他回答...',
    questionSendOther: '发送',
    questionTitle: '助手需要确认',
    questionYes: '是',
    systemCanvasOps: '已对画布执行 {applied}/{total} 个操作',
    systemCodexDone: '✓ Codex 完成',
    systemCodexError: 'Codex 出错: {message}',
    systemCodexStarted: 'Codex 开始处理',
    systemDone: '✓ 完成 · {turns} 轮 · {cost}',
    systemEmptyError: '(空错误)',
    systemError: '出错：{message}',
    systemToolComplete: '  ↳ 工具完成',
    systemToolError: '  ↳ 工具出错',
  },
  common: {
    cancel: '取消',
    delete: '删除',
    done: '完成',
    empty: '空',
    expand: '展开',
    fold: '折叠',
  },
  engineLabels: {
    'canvas-harness': '画布助手',
    'project-harness': '工程 Agent',
  },
  file: {
    noProject: '未打开工程',
    openProject: '打开工程',
    openProjectHint: '选择工程的代码文件夹',
    openProjectPrompt: '点上方「打开工程」选择代码文件夹',
    save: '保存',
  },
  git: {
    changes: '更改',
    diff: 'Diff',
    emptyChanges: '没有更改',
    emptyGraph: '没有提交记录',
    graph: '图表',
    loading: '读取中...',
    loadingDiff: '加载 diff...',
    loadingGraph: '加载图表...',
    noDiff: '没有 diff',
    openProjectPrompt: '先打开工程后查看 Git 状态。',
    refresh: '刷新',
    selectFile: '选择一个文件查看 diff',
  },
  language: {
    label: '语言',
    options: {
      en: 'English',
      zh: '中文',
    },
  },
  picker: {
    delete: '删除',
    history: '历史 / 切换',
    noMatch: '无匹配',
    rename: '重命名',
    renameHint: '双击改名',
    search: '搜索…',
  },
  settings: {
    title: '设置',
  },
  workspace: {
    deleteCanvasMessage: '确定删除画布「{name}」？画布内容将一并删除。',
    deleteCanvasTitle: '删除画布',
    deleteSessionMessage: '确定删除对话「{name}」？此操作不可撤销。',
    deleteSessionTitle: '删除对话',
    newCanvas: '新建画布',
    newSession: '新建对话',
    noCanvas: '无画布',
    noProject: '未打开工程',
    noSession: '无对话',
  },
}

export const uiText: Record<UiLanguage, UiText> = { en, zh }
export const uiLanguageOptions: UiLanguage[] = ['en', 'zh']

export function parseUiLanguage(value: string | null): UiLanguage {
  return value === 'zh' ? 'zh' : 'en'
}

export function formatUiText(template: string, vars: Record<string, string | number>): string {
  let text = template
  for (const [key, value] of Object.entries(vars)) text = text.replaceAll(`{${key}}`, String(value))
  return text
}

export function engineDisplayLabel(text: UiText, id: string, fallback: string): string {
  return id in text.engineLabels ? text.engineLabels[id as keyof UiText['engineLabels']] : fallback
}

export function localizeSystemNote(text: UiText, raw: string): string {
  if (raw === '  ↳ 工具完成') return text.chat.systemToolComplete
  if (raw === '  ↳ 工具出错') return text.chat.systemToolError
  if (raw === 'Codex 开始处理') return text.chat.systemCodexStarted
  if (raw === '✓ Codex 完成') return text.chat.systemCodexDone

  let match = /^✓ 完成 · (.+?) 轮 · (.+)$/.exec(raw)
  if (match) return formatUiText(text.chat.systemDone, { turns: match[1], cost: match[2] })

  match = /^Codex 出错: (.*)$/.exec(raw)
  if (match) return formatUiText(text.chat.systemCodexError, { message: match[1] || text.chat.systemEmptyError })

  match = /^出错：(.*)$/.exec(raw)
  if (match) return formatUiText(text.chat.systemError, { message: match[1] === '(空错误)' ? text.chat.systemEmptyError : match[1] })

  match = /^已对画布执行 (\d+)\/(\d+) 个操作$/.exec(raw)
  if (match) return formatUiText(text.chat.systemCanvasOps, { applied: match[1], total: match[2] })

  return raw
}

export function isSystemErrorNote(raw: string): boolean {
  return raw.startsWith('出错：') || raw.startsWith('Codex 出错:')
}
