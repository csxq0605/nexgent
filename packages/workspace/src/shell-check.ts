/**
 * Whether the host can run commands. On Windows commands go through
 * PowerShell: PowerShell 7 (`pwsh`) when it is installed, otherwise Windows
 * PowerShell 5.1 (`powershell.exe`, ADR 0022 decision 7) with a one-time
 * notice that recommends installing PowerShell 7 (the model writes PowerShell
 * 7 syntax such as `&&`, which 5.1 rejects). The Job Object launcher
 * (`windows-job.ts`) runs under either. When neither is found the host is
 * reported as not able to run commands.
 */
import { statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/** The result of {@link checkCommandShell}. */
export interface CommandShellStatus {
  /** The executable commands need on this platform (`pwsh` on Windows). */
  readonly shell: 'pwsh' | 'bash'
  /** Whether Nexgent depends on finding it at start-up (only on Windows). */
  readonly required: boolean
  /** Whether it was found; always `true` when not {@link required}. */
  readonly available: boolean
  /** Where it was found, when it was looked up and found. */
  readonly path?: string
  /** Which PowerShell was found (Windows only). */
  readonly edition?: PowerShellEdition
  /** Shown once to the user and the model when the 5.1 fallback is in use. */
  readonly notice?: string
}

/** The PowerShell flavours Nexgent can drive. */
export type PowerShellEdition = 'pwsh' | 'windows-powershell'

/** The PowerShell the host uses. */
export interface PowerShellChoice {
  readonly edition: PowerShellEdition
  /** Executable name or path to spawn. */
  readonly program: string
  /** Set for the 5.1 fallback. */
  readonly notice?: string
}

/** Inputs of {@link checkCommandShell}; defaults are the current process. */
export interface CommandShellCheckOptions {
  readonly platform?: NodeJS.Platform
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Explicit launcher path (`ProcessRunnerOptions.pwshPath`); checked instead of searching `PATH`. */
  readonly pwshPath?: string
  /** Whether a path is an existing file (tests inject this). */
  readonly isFile?: (path: string) => boolean
}

/** Message shown when {@link CommandShellStatus.available} is `false`. */
export const PWSH_MISSING_MESSAGE =
  'PowerShell was not found (neither pwsh nor powershell.exe). Nexgent runs every command through PowerShell on Windows. ' +
  'Install PowerShell 7 (for example `winget install --id Microsoft.PowerShell`) and restart Nexgent.'

/**
 * PowerShell writes its output (and decodes what native commands print) in
 * the console's code page, which on Windows PowerShell 5.1 is the OEM one
 * (GBK on a Chinese system), while Nexgent reads UTF-8: switch both ways to
 * UTF-8 without a byte-order mark. Harmless in PowerShell 7.
 */
export const UTF8_OUTPUT = 'try { $OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}'

/** Pure: `script` with output in UTF-8 ({@link UTF8_OUTPUT}). */
export function withUtf8Output(script: string): string {
  return `${UTF8_OUTPUT}\n${script}`
}

/** Shown once when Windows PowerShell 5.1 stands in for PowerShell 7. */
export const POWERSHELL_51_NOTICE =
  'PowerShell 7 (pwsh) was not found, so commands run in Windows PowerShell 5.1. Write 5.1 syntax: no `&&` / `||` chaining ' +
  '(use `;` and check `$LASTEXITCODE`). Installing PowerShell 7 is recommended ' +
  '(`winget install --id Microsoft.PowerShell`).'

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function envValue(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const key = Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : env[key]
}

/** Find `pwsh` the way Windows `CreateProcess` + `PATHEXT` would, or `undefined`. */
export function findPwsh(options: CommandShellCheckOptions = {}): string | undefined {
  const env = options.env ?? process.env
  const exists = options.isFile ?? isFile
  const platform = options.platform ?? process.platform
  const sep = platform === 'win32' ? ';' : delimiter
  const join2 = (dir: string, name: string): string => (platform === 'win32' ? `${dir.replace(/[\\/]+$/, '')}\\${name}` : join(dir, name))
  if (options.pwshPath !== undefined && /[\\/]/.test(options.pwshPath)) {
    return exists(options.pwshPath) ? options.pwshPath : undefined
  }
  const name = options.pwshPath ?? 'pwsh'
  const exts = platform === 'win32'
    ? (/\.[^\\/.]+$/.test(name) ? [''] : (envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(ext => ext !== ''))
    : ['']
  for (const raw of (envValue(env, 'PATH') ?? '').split(sep)) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1')
    if (dir === '') continue
    for (const ext of exts) {
      const candidate = join2(dir, name + ext.toLowerCase())
      if (exists(candidate)) return candidate
    }
  }
  return undefined
}

/** Pick PowerShell 7, else Windows PowerShell 5.1, else `undefined`. Pure over the injected probes. */
export function selectPowerShell(options: CommandShellCheckOptions = {}): (PowerShellChoice & { readonly path: string }) | undefined {
  const pwsh = findPwsh(options)
  if (pwsh !== undefined) return { edition: 'pwsh', program: options.pwshPath !== undefined ? pwsh : 'pwsh', path: pwsh }
  // An explicit launcher path is a deliberate choice; do not second-guess it.
  if (options.pwshPath !== undefined) return undefined
  const legacy = findPwsh({ ...options, pwshPath: 'powershell' })
  return legacy === undefined ? undefined : { edition: 'windows-powershell', program: 'powershell', path: legacy, notice: POWERSHELL_51_NOTICE }
}

let cachedChoice: PowerShellChoice | undefined
let noticeTaken = false

/** The PowerShell this process uses on Windows (probed once; falls back to the name `pwsh` when none is found). */
export function currentPowerShell(): PowerShellChoice {
  if (cachedChoice === undefined) {
    const found = selectPowerShell()
    if (found === undefined) return { edition: 'pwsh', program: 'pwsh' }
    cachedChoice = { edition: found.edition, program: found.program, ...(found.notice === undefined ? {} : { notice: found.notice }) }
  }
  return cachedChoice
}

/** The 5.1 notice the first time it is asked for, then `undefined`. */
export function takePowerShellNotice(choice: PowerShellChoice = currentPowerShell()): string | undefined {
  if (choice.notice === undefined || noticeTaken) return undefined
  noticeTaken = true
  return choice.notice
}

/** Forget the cached choice and the shown-notice flag (tests). */
export function resetPowerShellCache(): void {
  cachedChoice = undefined
  noticeTaken = false
}

/** Check, once at start-up, that commands can run on this host. Never throws. */
export function checkCommandShell(options: CommandShellCheckOptions = {}): CommandShellStatus {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return { shell: 'bash', required: false, available: true }
  const found = selectPowerShell({ ...options, platform })
  if (found === undefined) return { shell: 'pwsh', required: true, available: false }
  return {
    shell: 'pwsh', required: true, available: true, path: found.path, edition: found.edition,
    ...(found.notice === undefined ? {} : { notice: found.notice }),
  }
}

const CLIXML_HEADER = /#< CLIXML\r?\n?/g
const CLIXML_BLOCK = /<Objs\b[^>]*>([\s\S]*?)<\/Objs>(\r?\n)?/g

/** Pure: the text of a CLIXML string (`&lt;` and `_x000D__x000A_` style escapes undone). */
function clixmlText(text: string): string {
  return text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}

/** Pure: one `<Objs>` block as plain text: progress records dropped, error / warning strings as text; anything else kept as it was. */
function clixmlBlock(block: string, body: string): string {
  const rest = body.replace(/<Obj S="progress"[^>]*>[\s\S]*?<\/Obj>/g, '')
  let text = ''
  const other = rest.replace(/<S S="[^"]*">([\s\S]*?)<\/S>/g, (_match, inner: string) => {
    text += clixmlText(inner)
    return ''
  })
  return other.trim() === '' ? text : block
}

/**
 * Pure: PowerShell's serialized stderr (`#< CLIXML` and `<Objs>` blocks,
 * which Windows PowerShell writes when stderr is not a console) as plain
 * text: progress records such as "Preparing modules for first use" (which
 * the sandbox account's fresh profile shows on every command whatever
 * `$ProgressPreference` says) are dropped, error and warning strings become
 * their text. Text without the header stays as it was.
 */
export function stripProgressRecords(stderr: string): string {
  if (!stderr.includes('#< CLIXML')) return stderr
  return stderr.replace(CLIXML_HEADER, '').replace(CLIXML_BLOCK, (block: string, body: string) => clixmlBlock(block, body))
}

const CLIXML_START = '#< CLIXML'
const BLOCK_START = '<Objs'
const BLOCK_END = '</Objs>'

/**
 * {@link stripProgressRecords} for a stream that arrives in pieces: `push`
 * returns what can be passed on now (a block is held until it closes), and
 * `flush` the rest at the end.
 */
export function progressFilter(): { push(text: string): string; flush(): string } {
  let held = ''
  let serialized = false
  const decode = (text: string): string => text.replace(CLIXML_HEADER, '').replace(CLIXML_BLOCK, (block: string, body: string) => clixmlBlock(block, body))
  return {
    push(text: string): string {
      held += text
      let out = ''
      for (;;) {
        const markers = serialized ? [CLIXML_START, BLOCK_START] : [CLIXML_START]
        const found = markers.map(marker => held.indexOf(marker)).filter(index => index >= 0)
        if (found.length === 0) {
          // Keep a tail that may be the start of a marker split across pieces.
          let keep = Math.min(held.length, Math.max(...markers.map(marker => marker.length)) - 1)
          while (keep > 0 && !markers.some(marker => marker.startsWith(held.slice(held.length - keep)))) keep -= 1
          out += held.slice(0, held.length - keep)
          held = held.slice(held.length - keep)
          return out
        }
        const start = Math.min(...found)
        out += held.slice(0, start)
        held = held.slice(start)
        let end: number
        if (held.startsWith(CLIXML_START)) {
          serialized = true
          end = CLIXML_START.length
        } else {
          const close = held.indexOf(BLOCK_END)
          if (close < 0) return out
          end = close + BLOCK_END.length
        }
        // Wait for the line break that may follow (it goes with the header or block).
        if (held.length - end < 2 && '\r\n'.startsWith(held.slice(end))) return out
        if (held.startsWith('\r\n', end)) end += 2
        else if (held.startsWith('\n', end)) end += 1
        out += held.startsWith(CLIXML_START) ? '' : decode(held.slice(0, end))
        held = held.slice(end)
      }
    },
    flush(): string {
      const rest = serialized ? decode(held) : held
      held = ''
      return rest
    },
  }
}
