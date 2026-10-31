import type { Command, Option } from 'commander';
import { UsageError } from '../output.js';
import type { App } from '../app.js';

/**
 * Shell completion. The scripts are small and call back into
 * `ghcard __complete <words...>` for candidates, so they always match the
 * installed version's commands and flags without being regenerated.
 */
export function registerCompletion(program: Command, app: App): void {
  program
    .command('completion')
    .helpGroup('Account and agents:')
    .argument('<shell>', 'bash, zsh, or fish')
    .summary('Print a shell completion script')
    .description('Print a completion script for your shell. Add the line below to its startup file.')
    .addHelpText(
      'after',
      `
Setup:
  bash  echo 'eval "$(ghcard completion bash)"' >> ~/.bashrc
  zsh   echo 'eval "$(ghcard completion zsh)"' >> ~/.zshrc
  fish  ghcard completion fish > ~/.config/fish/completions/ghcard.fish
`
    )
    .action((shell: string) => {
      const script = SCRIPTS[shell];
      if (!script) throw new UsageError('shell must be bash, zsh, or fish');
      app.options.stdout.write(script);
    });

  // Hidden: the completion scripts' backend. Prints one candidate per line.
  program
    .command('__complete', { hidden: true })
    .argument('[words...]')
    .allowUnknownOption()
    .helpOption(false)
    .action((words: string[]) => {
      for (const candidate of complete(program, words)) app.options.stdout.write(`${candidate}\n`);
    });
}

/**
 * Candidates for the last word, given the words typed after `ghcard`. The
 * last word is the one being completed and may be empty.
 */
export function complete(program: Command, words: string[]): string[] {
  const current = words.at(-1) ?? '';
  let command = program;
  for (const word of words.slice(0, -1)) {
    const sub = command.commands.find(c => c.name() === word || c.aliases().includes(word));
    if (sub) command = sub;
  }
  const visible = (c: Command) => !(c as unknown as { _hidden?: boolean })._hidden;
  const flags = (c: Command) =>
    c.options.flatMap((o: Option) => [o.long, o.short]).filter((f): f is string => Boolean(f));

  const candidates = current.startsWith('-')
    ? [...flags(command), ...(command === program ? [] : flags(program)), '--help']
    : command.commands.filter(visible).map(c => c.name());
  return [...new Set(candidates)].filter(c => c.startsWith(current)).sort();
}

const BASH = `# ghcard completion for bash
_ghcard() {
  local words=("\${COMP_WORDS[@]:1:COMP_CWORD}") out
  out=$(ghcard __complete "\${words[@]}" 2>/dev/null) || return
  local IFS=$'\\n'
  COMPREPLY=($out)
}
complete -o default -F _ghcard ghcard
`;

const ZSH = `#compdef ghcard
# ghcard completion for zsh
_ghcard() {
  local -a candidates
  candidates=("\${(@f)$(ghcard __complete "\${(@)words[2,CURRENT]}" 2>/dev/null)}")
  if (( \${#candidates} )) && [[ -n "\${candidates[1]}" ]]; then
    compadd -- "\${candidates[@]}"
  else
    _files
  fi
}
compdef _ghcard ghcard
`;

const FISH = `# ghcard completion for fish
complete -c ghcard -f -a '(ghcard __complete (commandline -opc)[2..-1] (commandline -ct) 2>/dev/null)'
`;

const SCRIPTS: Record<string, string> = { bash: BASH, zsh: ZSH, fish: FISH };
