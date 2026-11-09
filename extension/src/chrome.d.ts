// Minimal typing of the Chrome extension APIs used here (avoids a @types/chrome dependency).
/** Set by extension/scripts/build.ts: true only in the browser-test build. */
declare const __TEST_BUILD__: boolean;
declare namespace chrome {
  namespace runtime {
    function sendMessage<T = unknown>(msg: unknown): Promise<T>;
    const onMessage: { addListener(cb: (msg: any, sender: unknown, send: (r: unknown) => void) => boolean | void): void };
    function getURL(path: string): string;
    function openOptionsPage(): Promise<void>;
  }
  namespace storage {
    const local: { get(keys: string[] | string | null): Promise<Record<string, any>>; set(items: Record<string, unknown>): Promise<void> };
  }
  namespace tabs {
    /** Opens a tab (needs no "tabs" permission). Used to open the screenshot mode in a tab. */
    function create(p: { url: string }): Promise<unknown>;
  }
  namespace permissions {
    function contains(p: { origins?: string[] }): Promise<boolean>;
    function request(p: { origins?: string[] }): Promise<boolean>;
  }
}
