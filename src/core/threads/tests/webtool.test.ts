import { describe, expect, it } from "vitest";

import { webToolKind } from "../views.js";

describe("webToolKind", () => {
  it("knows the built-in web tools of every provider", () => {
    expect(webToolKind("WebSearch")).toBe("search");
    expect(webToolKind("WebFetch")).toBe("fetch");
    expect(webToolKind("websearch")).toBe("search");
    expect(webToolKind("default.web_fetch")).toBe("fetch");
    expect(webToolKind("mcp__fetch__fetch")).toBe("fetch");
  });

  it("knows the Exa and Brave Search servers' tools", () => {
    expect(webToolKind("mcp__exa__web_search_exa")).toBe("search");
    expect(webToolKind("mcp__exa__web_fetch_exa")).toBe("fetch");
    expect(webToolKind("mcp__brave-search__brave_web_search")).toBe("search");
    expect(webToolKind("mcp__brave-search__brave_news_search")).toBe("search");
    expect(webToolKind("mcp__brave-search__brave_image_search")).toBe("search");
    expect(webToolKind("mcp__brave-search__brave_video_search")).toBe("search");
    expect(webToolKind("mcp__brave-search__brave_local_search")).toBe("search");
    expect(webToolKind("mcp__brave-search__brave_place_search")).toBe("search");
  });

  it("leaves other tools alone", () => {
    expect(webToolKind("Bash")).toBeNull();
    expect(webToolKind("mcp__linear__list_issues")).toBeNull();
    // The research agent and the summarizer are not a plain search or fetch.
    expect(webToolKind("mcp__exa__agent_run")).toBeNull();
    expect(webToolKind("mcp__brave-search__brave_summarizer")).toBeNull();
    expect(webToolKind("mcp__brave-search__brave_llm_context")).toBeNull();
  });
});
