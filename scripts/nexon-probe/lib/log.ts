/**
 * 콘솔 출력 게이트.
 *
 * **모든 출력은 반드시 여기를 통과한다.** scrubber 를 마지막 관문으로 두어
 * 실수로라도 API 키가 콘솔에 찍히지 않게 한다.
 *
 * 참고: 이 도구는 Node 의 네이티브 타입 스트리핑으로 실행되므로
 * **파라미터 프로퍼티(`constructor(private x: T)`)를 쓸 수 없다.** 필드를 명시적으로 선언한다.
 */

export class Logger {
  private scrub: (text: string) => string

  constructor(scrub: (text: string) => string = (text) => text) {
    this.scrub = scrub
  }

  /** 키를 알게 된 뒤 scrubber 를 갈아 끼운다. */
  setScrubber(scrub: (text: string) => string): void {
    this.scrub = scrub
  }

  clean(text: string): string {
    return this.scrub(text)
  }

  line(text = ''): void {
    console.log(this.scrub(text))
  }

  section(title: string): void {
    this.line('')
    this.line(`── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`)
  }

  warn(text: string): void {
    console.warn(this.scrub(`[warn] ${text}`))
  }

  error(text: string): void {
    console.error(this.scrub(`[error] ${text}`))
  }
}
