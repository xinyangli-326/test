import json, os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
ROOT=Path(__file__).resolve().parent
KB=json.loads((ROOT/'knowledge_base.json').read_text(encoding='utf-8-sig'))
PERSONAS=['酒店老板','店长','业主','总经理','收益总监','市场营销总监','酒店采购','酒店经理','销售总监','前厅经理','客房经理','财务总监','工程总监','品牌总监','投资人','酒店顾问','酒店供应商','一线销售','住客','宠物主','亲子家庭']
def client():
 from openai import OpenAI
 return OpenAI(api_key=os.getenv('OPENAI_API_KEY'))
def generate(p):
 cat=KB['categories'].get(p.get('category'),{}); prompt=f'''你是携程酒店服务市场的酒店营销内容专家。为以下任务输出具体、可落地的Markdown完整成稿。
知识库大类：{cat.get('name')}；定义：{cat.get('description')}；可参考主题：{cat.get('topics')}
产品/主题：{p.get('product')}；目标视角：{p.get('persona')}；内容渠道：{p.get('channel')}；内容类型：{p.get('content_type')}；补充信息：{p.get('extra')}
联网研究：{p.get('research') or '无'}；文章风格样本：{str(p.get('style_samples') or '')[:12000]}
要求：内容必须具体回答覆盖人群、需求场景、转化动作、指标和风险。朋友圈写3条180-350字长文案；小红书写完整种草或知识型成稿；其他渠道按其传播习惯完整输出。不得编造平台规则和具体数据，内部数字注明参考值。输出适用场景、核心钩子、完整正文、配图建议、CTA、风险提示。'''
 return client().responses.create(model=os.getenv('OPENAI_MODEL','gpt-4o'),input=prompt,max_output_tokens=6500,temperature=.85).output_text
def poster_copy(p):
 prompt=f'''为Trip MALL携程酒店服务市场生成一套竖版营销海报短文案。
产品/主题：{p.get('product')}；知识库：{p.get('category_name')}；营销目标：{p.get('goal')}；目标视角：{p.get('persona')}。
只返回严格JSON，不要Markdown：{{"eyebrow":"12字以内","headline":"14字以内","subheadline":"24字以内","price":"价格或核心利益，16字以内","features":["8字以内","8字以内","8字以内"],"metrics":[{{"value":"短数字","label":"8字以内"}},{{"value":"短数字","label":"8字以内"}},{{"value":"短数字","label":"8字以内"}}],"cta":"12字以内"}}。
没有可靠数字时用“省心采购”“一站服务”等利益点，不编造数据。'''
 r=client().responses.create(model=os.getenv('OPENAI_MODEL','gpt-4o'),input=prompt,max_output_tokens=1000)
 text=r.output_text.strip().removeprefix('```json').removesuffix('```').strip()
 return json.loads(text)
def research(p):
 prompt=f'''联网研究酒店行业主题“{p.get('product')}”，服务于携程酒店服务市场{p.get('category_name')}内容创作。查找最新公开趋势、目标人群、竞品内容、社媒高互动选题、采购或运营问题。指定链接：{p.get('urls')}。受限链接必须说明无法读取，不能猜。输出事实、来源、竞品启发和可执行选题，不复制原文。'''
 return client().responses.create(model=os.getenv('OPENAI_RESEARCH_MODEL',os.getenv('OPENAI_MODEL','gpt-4o')),tools=[{'type':'web_search_preview'}],input=prompt,max_output_tokens=3500).output_text
def image(prompt,size='1024x1024'):
 r=client().images.generate(model=os.getenv('OPENAI_IMAGE_MODEL','gpt-image-2'),prompt=prompt,size=size,quality='medium',background='transparent' if size=='1024x1024' else 'opaque');return r.data[0].b64_json
class H(SimpleHTTPRequestHandler):
 def __init__(self,*a,**k):super().__init__(*a,directory=str(ROOT),**k)
 def respond(self,n,d):
  b=json.dumps(d,ensure_ascii=False).encode();self.send_response(n);self.send_header('Content-Type','application/json;charset=utf-8');self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b)
 def do_GET(self):
  if self.path.endswith('/api/knowledge'):self.respond(200,KB)
  else:super().do_GET()
 def do_POST(self):
  try:
   p=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))) or b'{}')
   if not os.getenv('OPENAI_API_KEY'):raise RuntimeError('未设置 OPENAI_API_KEY')
   if self.path.endswith('/api/generate'):self.respond(200,{'content':generate(p)})
   elif self.path.endswith('/api/poster-copy'):self.respond(200,poster_copy(p))
   elif self.path.endswith('/api/research'):self.respond(200,{'content':research(p)})
   elif self.path.endswith('/api/sticker'):
    subject=str(p.get('subject','卡通橘猫'))
    banned=['小黄人','蛋仔派对','迪士尼','玲娜贝儿','奥特曼','宝可梦']
    if any(x in subject for x in banned):raise ValueError('商业IP贴纸请上传已获得授权的透明PNG素材；AI贴纸仅生成原创或通用角色。')
    prompt=f'''Create one original cute sticker: {subject}. Transparent background, bold clean outline, full body, expressive pose, polished commercial sticker art, no text, no logo, no copyrighted character imitation.'''
    self.respond(200,{'image':'data:image/png;base64,'+image(prompt)})
   elif self.path.endswith('/api/poster'):
    prompt=f'''Vertical 9:16 hotel marketing background for {p.get('product')}. Style {p.get('style')}. Motifs {p.get('elements')}. Brand palette champagne gold #C39F77, warm ivory, dark coffee. No text, no logos, clean zones for copy, premium Trip MALL hotel service marketplace feeling. No copyrighted characters.'''
    self.respond(200,{'image':'data:image/png;base64,'+image(prompt,'1024x1536')})
   else:self.send_error(404)
  except Exception as e:self.respond(400,{'error':str(e)})
if __name__=='__main__':
 print('Trip MALL营销知识库：http://127.0.0.1:8000');ThreadingHTTPServer(('127.0.0.1',8000),H).serve_forever()


