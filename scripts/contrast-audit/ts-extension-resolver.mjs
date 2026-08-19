/**
 * Node ESM resolve hook: 확장자 없는 상대 경로 import 를 `.ts` 로 보정한다.
 *
 * 왜 필요한가
 * - 루트 tsconfig 는 `moduleResolution: "bundler"` 이며 `allowImportingTsExtensions` 가
 *   꺼져 있다. 소스에 `./foo.ts` 라고 쓰면 `pnpm typecheck` 가 TS5097 로 실패한다.
 * - 반대로 Node 24 의 네이티브 타입 스트리핑(ESM)은 상대 경로에 확장자를 요구한다.
 * - 소스는 확장자 없이 쓰고(타입체크 통과) 런타임에서만 `.ts` 를 붙여 해석한다.
 *
 * 이 파일은 도구 전용이며 애플리케이션 코드(`src/`)에는 관여하지 않는다.
 * 새 의존성(tsx 등)을 추가하지 않기 위한 선택이다.
 */

/** @type {import('node:module').ResolveHook} */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    try {
      return await nextResolve(specifier, context);
    } catch (error) {
      const code = /** @type {{ code?: string }} */ (error)?.code;
      if (code === 'ERR_MODULE_NOT_FOUND') {
        return await nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  }
  return nextResolve(specifier, context);
}
