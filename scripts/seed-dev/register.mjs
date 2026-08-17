/**
 * `node --import ./scripts/seed-dev/register.mjs ./scripts/seed-dev/main.ts`
 * 형태로 쓰인다. `ts-extension-resolver.mjs` 를 모듈 해석 훅으로 등록한다.
 *
 * `scripts/nexon-probe` 의 같은 이름 파일과 내용이 같지만 **의도적으로 복제**했다.
 * 두 도구는 서로 독립이어야 하며, 한쪽을 지워도 다른 쪽이 깨지면 안 되기 때문이다.
 */
import { register } from 'node:module';

register('./ts-extension-resolver.mjs', import.meta.url);
