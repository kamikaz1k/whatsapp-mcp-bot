import { describe, expect, it, vi } from "vitest"

// The agent module imports the Agents SDK, which needs the Workers runtime; only the
// pure helper is tested here.
vi.mock("agents", () => ({ Agent: class {} }))

const { workflowId } = await import("../src/agent")

describe("workflowId", () => {
  it("is a valid, stable workflow instance id", () => {
    const id = workflowId("3EB0C1D2E3F4@abc.def")
    expect(id).toBe("reply-3EB0C1D2E3F4_abc_def")
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,100}$/)
    expect(workflowId("x".repeat(200)).length).toBeLessThanOrEqual(100)
  })
})
