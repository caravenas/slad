---
type: "query"
date: "2026-06-19T02:47:26.822891+00:00"
question: "Why does ModelProvider bridge nearly every subsystem (Pipeline Runner, Explore/Evolve, Decision Gate, Auto HITL, Ask/Auto/Learn commands)?"
contributor: "graphify"
source_nodes: ["ModelProvider", "PipelineServices", "SladServices", "runPipeline", "createAgent", "HITLTransport"]
---

# Q: Why does ModelProvider bridge nearly every subsystem (Pipeline Runner, Explore/Evolve, Decision Gate, Auto HITL, Ask/Auto/Learn commands)?

## Answer

ModelProvider (packages/model-providers/src/index.ts:35) is a type/interface, not a class. 33 edges, nearly all INCOMING imports - classic dependency-inversion hub, highest betweenness in graph. Importers span 5 clusters: provider adapters (anthropic/openai/gemini/adapter), pipeline stages (slad-runner, runPipeline, explorer, defineStage), agent SDK (createAgent, AgentConfig, compose), HITL/orchestration (hitl-loop, HITLTransport, auto.ts, slad.ts), blueprints/examples (enterprise main.ts, research-agent, demo.agent). Connective tissue is the service container: PipelineServices and SladServices both reference ModelProvider, and runPipeline threads it into every stage. It is the seam between orchestration (what to do) and provider adapters (how to call the LLM). Everything depends on the abstraction; the abstraction depends on nothing.

## Source Nodes

- ModelProvider
- PipelineServices
- SladServices
- runPipeline
- createAgent
- HITLTransport