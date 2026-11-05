// Local visual QA only. The --demo fixture never enters the deployed Site.
import { createServer } from "node:http";
import worker from "../worker/index.js";

class Bucket {
  records = new Map();
  async put(key, value, options) { this.records.set(key, { value, customMetadata: options?.customMetadata }); }
  async get(key) {
    const record = this.records.get(key);
    return record === undefined ? null : { json: async () => JSON.parse(record.value) };
  }
  async delete(key) { this.records.delete(key); }
  async list({ prefix, limit }) {
    const objects = [...this.records.keys()].filter((key) => key.startsWith(prefix)).slice(0, limit)
      .map((key) => ({ key, customMetadata: this.records.get(key).customMetadata }));
    return { objects, truncated: false };
  }
}
const env = { BUCKET: new Bucket() };
if (process.argv.includes("--demo")) {
  const source = "عملية التمثيل الضوئي تستخدم الضوء لتحويل الماء وثاني أكسيد الكربون إلى جلوكوز وأكسجين داخل البلاستيدات الخضراء. تؤثر شدة الضوء في سرعة العملية حتى يصل النبات إلى حد تشبع.";
  const questions = [
    { stem: "ما الناتجان المذكوران لعملية التمثيل الضوئي؟", objective: "تحديد ناتج العملية", identity: "Basic Recall", source_page: 3,
      evidence: "إلى جلوكوز وأكسجين داخل البلاستيدات الخضراء", explanation: "يذكر المصدر أن الجلوكوز والأكسجين ناتجان من العملية.", correct_choice_id: "a",
      choices: [{ id: "a", text: "الجلوكوز والأكسجين" }, { id: "b", text: "الماء والنيتروجين" }, { id: "c", text: "ثاني أكسيد الكربون فقط" }, { id: "d", text: "الضوء والماء" }] },
    { stem: "ماذا يحدث لسرعة العملية مع زيادة شدة الضوء حتى الوصول إلى حد التشبع؟", objective: "تفسير تأثير شدة الضوء", identity: "Understanding", source_page: 3,
      evidence: "تؤثر شدة الضوء في سرعة العملية حتى يصل النبات إلى حد تشبع", explanation: "تزداد السرعة مع الضوء حتى حد التشبع المذكور في المصدر.", correct_choice_id: "b",
      choices: [{ id: "a", text: "تبقى ثابتة منذ البداية" }, { id: "b", text: "تزداد إلى حد التشبع" }, { id: "c", text: "تنخفض فورًا" }, { id: "d", text: "تتوقف كليًا" }] },
    { stem: "أين تتم العملية بحسب نص المحاضرة؟", objective: "تحديد موقع العملية", identity: "Mechanisms & Detail", source_page: 3,
      evidence: "داخل البلاستيدات الخضراء", explanation: "النص يحدد البلاستيدات الخضراء مكانًا للعملية.", correct_choice_id: "c",
      choices: [{ id: "a", text: "داخل النواة" }, { id: "b", text: "في الريبوسومات" }, { id: "c", text: "داخل البلاستيدات الخضراء" }, { id: "d", text: "في جدار الخلية" }] }
  ];
  const request = new Request("http://127.0.0.1:4174/mcp", {
    method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-id": "preview-student" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_quiz_from_slides",
      arguments: { title: "التمثيل الضوئي", source_name: "محاضرة الأحياء.pdf", pages: [{ number: 3, text: source }], questions } } })
  });
  const result = (await (await worker.fetch(request, env)).json()).result;
  if (result.isError) throw new Error(result.content[0].text);
}
const port = Number(process.env.PORT || 4174);
createServer(async (request, response) => {
  const body = request.method === "GET" || request.method === "HEAD" ? undefined
    : Buffer.concat(await Array.fromAsync(request));
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  const headers = new Headers(request.headers);
  headers.set("oai-authenticated-user-id", "preview-student");
  const input = new Request(url, { method: request.method, headers, body });
  const output = await worker.fetch(input, env);
  response.writeHead(output.status, Object.fromEntries(output.headers));
  response.end(Buffer.from(await output.arrayBuffer()));
}).listen(port, "127.0.0.1", () => console.log(`Local Quizzy preview: http://127.0.0.1:${port}`));
