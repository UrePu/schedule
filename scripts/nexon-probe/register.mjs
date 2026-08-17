/**
 * `node --import ./scripts/nexon-probe/register.mjs ./scripts/nexon-probe/main.ts`
 * 형태로 쓰인다. `ts-extension-resolver.mjs` 를 모듈 해석 훅으로 등록한다.
 */
import { register } from 'node:module';

register('./ts-extension-resolver.mjs', import.meta.url);
