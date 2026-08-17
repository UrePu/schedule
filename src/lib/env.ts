/**
 * 환경변수 접근 헬퍼.
 *
 * `NEXT_PUBLIC_*` 변수는 Next 가 빌드 시 정적으로 치환하므로 반드시 호출부에서
 * `process.env.NEXT_PUBLIC_X` 형태로 **직접** 읽어 이 함수에 값으로 넘겨야 한다.
 * (`process.env[name]` 처럼 동적으로 읽으면 클라이언트 번들에서 undefined 가 된다.)
 */
export function requireEnv(name: string, value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `[env] 환경변수 ${name} 가 설정되지 않았습니다. ` +
        `.env.local.example 을 .env.local 로 복사한 뒤 값을 채워주세요.`,
    );
  }

  return value;
}
