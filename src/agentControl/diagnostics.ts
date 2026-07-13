const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g')

export function cleanAgentDiagnostic(value: string): string {
  return value.replace(ansiEscape, '').trim()
}
