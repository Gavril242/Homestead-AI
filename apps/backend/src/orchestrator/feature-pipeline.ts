import { StateGraph, START, END, MemorySaver, Annotation, MessagesAnnotation } from "@langchain/langgraph";
import { AIMessage, HumanMessage, ToolMessage, BaseMessage } from "@langchain/core/messages";
import { ChatAnthropic } from "@langchain/anthropic";
import { repo } from "../db.js";
import { TOOLS } from "../tools/registry.js";

// ---------------------------------------------------------------------------
// 1. STATE & MEMORY DEFINITION
// ---------------------------------------------------------------------------
const memory = new MemorySaver();

// Define the schema for our graph state using the modern Annotation API
const GraphAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,
  ticketId: Annotation<string>({
    reducer: (x: string, y: string) => y ?? x,
    default: () => "UNKNOWN-TICKET",
  }),
  projectId: Annotation<string>({
    reducer: (x: string, y: string) => y ?? x,
    default: () => "UNKNOWN-PROJECT",
  }),
  humanApproved: Annotation<boolean>({
    reducer: (x: boolean, y: boolean) => y ?? x,
    default: () => false,
  })
});

// ---------------------------------------------------------------------------
// 2. TOOL INTEGRATION
// ---------------------------------------------------------------------------
const toolDefinitions = TOOLS.map(t => ({
  type: "function" as const,
  function: {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }
}));

const executeToolByName = async (name: string, args: any, ctx: any) => {
  const t = TOOLS.find(x => x.name === name);
  if (!t) throw new Error(`Tool not found: ${name}`);
  return await t.execute(args, ctx);
};

// ---------------------------------------------------------------------------
// 3. AGENT NODES
// ---------------------------------------------------------------------------
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

let _model: any = null;
function getModel() {
  if (!_model) {
    if (process.env.ANTHROPIC_API_KEY) {
      console.log("[LangGraph] Using Anthropic model");
      _model = new ChatAnthropic({ 
        modelName: "claude-3-7-sonnet-20250219", 
        temperature: 0,
        apiKey: process.env.ANTHROPIC_API_KEY,
      }).bindTools(toolDefinitions);
    } else if (process.env.GEMINI_KEY_1) {
      console.log("[LangGraph] Using Gemini model (fallback)");
      _model = new ChatGoogleGenerativeAI({
        modelName: "gemini-2.0-flash", // Use a stable Gemini 2.0 model
        apiKey: process.env.GEMINI_KEY_1,
        temperature: 0,
      }).bindTools(toolDefinitions as any);
    } else {
      throw new Error("No LLM API keys found (ANTHROPIC_API_KEY or GEMINI_KEY_1)");
    }
  }
  return _model;
}

async function agentNode(state: typeof GraphAnnotation.State) {
  console.log(`[Agent] Thinking about ticket ${state.ticketId}...`);
  const response = await getModel().invoke(state.messages);
  return { messages: [response] };
}

async function executionNode(state: typeof GraphAnnotation.State) {
  const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
  
  if (!lastMessage.tool_calls || lastMessage.tool_calls.length === 0) {
    return { 
      messages: [new HumanMessage("Execution halted: No tool calls were generated. Please use the appropriate tools to progress the task.")] 
    };
  }

  const toolOutputs: BaseMessage[] = [];
  const ctx = { 
    repo, 
    agentId: "langgraph-orchestrator", 
    projectId: state.projectId,
    broadcast: (msg: any) => { /* console.log('Broadcast:', msg); */ } 
  };

  for (const tc of lastMessage.tool_calls) {
    try {
      console.log(`[Executor] Running tool: ${tc.name}...`);
      const result = await executeToolByName(tc.name, tc.args, ctx);
      toolOutputs.push(new ToolMessage({ 
        tool_call_id: tc.id!, 
        content: typeof result === 'string' ? result : JSON.stringify(result) 
      }));
    } catch (error: any) {
      console.log(`[Executor] Tool ${tc.name} failed!`);
      toolOutputs.push(new ToolMessage({ 
        tool_call_id: tc.id!, 
        content: `Error: ${error.message}` 
      }));
    }
  }

  return { messages: toolOutputs };
}

// ---------------------------------------------------------------------------
// 4. ROUTING LOGIC
// ---------------------------------------------------------------------------
function shouldContinue(state: typeof GraphAnnotation.State) {
  const lastMessage = state.messages[state.messages.length - 1];
  
  if (lastMessage instanceof AIMessage && lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
    return "execution";
  }

  const content = lastMessage.content.toString();
  if (content.includes("Successfully") || content.includes("COMPLETE") || content.includes("FINISHED")) {
    return "human_gate";
  }

  if (lastMessage instanceof ToolMessage && lastMessage.content.toString().includes("Error:")) {
    return "agent";
  }

  return END;
}

function checkApproval(state: typeof GraphAnnotation.State) {
  if (state.humanApproved) {
    return END;
  }
  return "agent";
}

// ---------------------------------------------------------------------------
// 5. GRAPH CONSTRUCTION
// ---------------------------------------------------------------------------
export const featurePipeline = new StateGraph(GraphAnnotation)
  .addNode("agent", agentNode)
  .addNode("execution", executionNode)
  .addNode("human_gate", () => { 
    console.log("--- WAITING FOR HUMAN APPROVAL ---"); 
    return {}; 
  }) 
  
  .addEdge(START, "agent")
  .addConditionalEdges("agent", shouldContinue)
  .addEdge("execution", "agent") 
  .addConditionalEdges("human_gate", checkApproval);

export const app = featurePipeline.compile({
  checkpointer: memory,
  interruptBefore: ["human_gate"]
});
