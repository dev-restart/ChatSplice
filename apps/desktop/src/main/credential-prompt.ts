import { spawn } from 'node:child_process';

import type { UiLocale } from '@chatsplice/protocol';

const MAX_PROMPT_OUTPUT_BYTES = 4096;

export function buildTunnelCredentialPromptScript(locale: UiLocale): string {
  const copy =
    locale === 'ko'
      ? {
          prompt:
            'OpenAI Secure MCP Tunnel runtime key를 입력하세요. 이 값은 ChatSplice 화면이나 로그에 표시되지 않고 macOS Keychain으로 보호됩니다.',
          cancel: '취소',
          save: '저장',
        }
      : {
          prompt:
            'Enter the OpenAI Secure MCP Tunnel runtime key. It is not shown in ChatSplice or logs and is protected by the macOS Keychain.',
          cancel: 'Cancel',
          save: 'Save',
        };
  return `
set dialogResult to display dialog ${JSON.stringify(copy.prompt)} default answer "" with hidden answer buttons {${JSON.stringify(copy.cancel)}, ${JSON.stringify(copy.save)}} default button ${JSON.stringify(copy.save)} cancel button ${JSON.stringify(copy.cancel)} with title "ChatSplice"
return text returned of dialogResult
`;
}

export function promptForTunnelCredential(locale: UiLocale): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-e', buildTunnelCredentialPromptScript(locale)], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output: Buffer[] = [];
    let outputSize = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > MAX_PROMPT_OUTPUT_BYTES) {
        child.kill('SIGTERM');
        return;
      }
      output.push(chunk);
    });
    child.stderr.resume();
    child.once('error', () => reject(new Error('Secure credential prompt could not be opened.')));
    child.once('exit', (code) => {
      if (outputSize > MAX_PROMPT_OUTPUT_BYTES) {
        reject(new Error('Secure credential prompt returned too much data.'));
        return;
      }
      if (code !== 0) {
        resolve(null);
        return;
      }
      const credential = Buffer.concat(output).toString('utf8').trim();
      resolve(credential === '' ? null : credential);
    });
  });
}
