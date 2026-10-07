/** Creates/verifies a no-model native Langflow fixture; never runs other flows. */
const base = 'http://127.0.0.1:7860';
export const echoName = 'AI Studio 回声验证（无模型调用）';

async function json(path, body, method) {
  const response = await fetch(`${base}${path}`, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Langflow request failed: ${response.status} ${path}`);
  return response.json();
}

export async function ensureEcho() {
  const catalogue = await json('/api/v1/all');
  const components = catalogue.input_output;
  if (!components?.ChatInput || !components?.ChatOutput) throw new Error('Native Chat Input/Output components unavailable.');
  const list = await json('/api/v1/flows/?header_flows=true&get_all=false&page=1&size=100');
  const existing = (Array.isArray(list) ? list : list.items || []).find(flow => flow.name === echoName);
  if (existing) {
    const flow = await json(`/api/v1/flows/${existing.id}`);
    assertEcho(flow, components);
    const input = flow.data.nodes.find(node => node.data.type === 'ChatInput');
    const output = flow.data.nodes.find(node => node.data.type === 'ChatOutput');
    const edge = nativeEdge(input, output, components);
    if (flow.data.edges[0].sourceHandle !== edge.sourceHandle || flow.data.edges[0].targetHandle !== edge.targetHandle) {
      // Repair only our verified two-component fixture's port serialization.
      if (flow.locked) await json(`/api/v1/flows/${flow.id}`, { locked: false }, 'PATCH');
      try { await json(`/api/v1/flows/${flow.id}`, { data: { ...flow.data, edges: [edge] } }, 'PATCH'); }
      finally { if (flow.locked) await json(`/api/v1/flows/${flow.id}`, { locked: true }, 'PATCH'); }
    }
    return { id: flow.id, name: flow.name };
  }
  const examples = await json('/api/v1/flows/?get_all=true');
  const example = (Array.isArray(examples) ? examples : examples.items || []).find(flow =>
    flow.data?.nodes?.some(node => node.data?.type === 'ChatInput') && flow.data?.nodes?.some(node => node.data?.type === 'ChatOutput'));
  if (!example) throw new Error('Native example node envelope unavailable.');
  const input = structuredClone(example.data.nodes.find(node => node.data?.type === 'ChatInput'));
  const output = structuredClone(example.data.nodes.find(node => node.data?.type === 'ChatOutput'));
  for (const [node, type, position] of [[input, 'ChatInput', { x: 80, y: 120 }], [output, 'ChatOutput', { x: 520, y: 120 }]]) {
    node.data.node = structuredClone(components[type]);
    node.data.type = type; node.data.id = node.id;
    node.position = position; node.positionAbsolute = position; node.selected = false; node.dragging = false;
    if (node.data.node.template.should_store_message) node.data.node.template.should_store_message.value = false;
  }
  const edge = nativeEdge(input, output, components);
  const flow = await json('/api/v1/flows/', {
    name: echoName, description: 'Native Chat Input → Chat Output. No model, network tool or paid provider.',
    data: { nodes: [input, output], edges: [edge], viewport: { x: 0, y: 0, zoom: 1 } },
    is_component: false, locked: true, access_type: 'PRIVATE',
  });
  assertEcho(flow, components);
  return { id: flow.id, name: flow.name };
}

function assertEcho(flow, components) {
  if (flow.data?.nodes?.length !== 2 || flow.data?.edges?.length !== 1) throw new Error('Echo fixture changed; no execution issued.');
  const types = flow.data.nodes.map(node => node.data?.type).sort();
  if (JSON.stringify(types) !== JSON.stringify(['ChatInput', 'ChatOutput'])) throw new Error('Echo fixture is not a no-model graph.');
  for (const node of flow.data.nodes) {
    if (node.data.node?.template?.code?.value !== components[node.data.type].template.code.value) throw new Error('Echo component code changed; no execution issued.');
    if (node.data.type === 'ChatInput' && (node.data.node.template.files?.value || []).length !== 0) throw new Error('Echo has attachments; no execution issued.');
  }
}

function nativeEdge(input, output, components) {
  const port = components.ChatInput.outputs.find(item => item.name === 'message');
  const field = components.ChatOutput.template.input_value;
  const sourceHandle = { dataType: 'ChatInput', id: input.id, name: port.name, output_types: port.types };
  const targetHandle = { fieldName: 'input_value', id: output.id, inputTypes: field.input_types, type: field.type };
  // The native renderer uses compact JSON with its quote-escape character.
  const handleId = value => JSON.stringify(value).replaceAll('"', 'œ');
  return { id: 'aistudio-native-echo', source: input.id, target: output.id,
    sourceHandle: handleId(sourceHandle), targetHandle: handleId(targetHandle),
    data: { sourceHandle, targetHandle }, animated: false, selected: false };
}

if (process.argv[1]?.endsWith('langflow-echo.mjs')) {
  const flow = await ensureEcho();
  console.log(JSON.stringify(flow));
  if (process.argv.includes('--verify')) {
    const marker = `Langflow 原生回声验证 ${Date.now()}`;
    const result = await json(`/api/v1/run/${flow.id}?stream=false`, {
      input_request: { input_value: marker, input_type: 'chat', output_type: 'chat', session_id: `aistudio-echo-${Date.now()}` },
    });
    const outputs = result.outputs?.flatMap(group => group.outputs || []) || [];
    const texts = outputs.map(output => output.results?.message?.text || output.messages?.[0]?.message || '').filter(Boolean);
    if (!texts.some(text => text === marker)) throw new Error('Native Langflow response did not echo the input.');
    console.log(JSON.stringify({ verified: true, flowId: flow.id, output: texts.join('\n') }));
  }
}
