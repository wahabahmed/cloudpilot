import os
from openai import OpenAI
from .storage import storage

client = OpenAI(api_key=os.environ["DEEPSEEK_API_KEY"],
                base_url="https://api.deepseek.com")

SYSTEM_PROMPT = """You are a Terraform expert. Output ONLY raw, valid Terraform HCL.
Do not include markdown code fences. Do not include explanation.
Output a single main.tf with the provider block and all resources.
Do not include a backend block."""


def nlp_to_terraform(tenant_id: int, request_id: int, nlp_text: str) -> dict:
    r = client.chat.completions.create(
        model="deepseek-chat",
        messages=[{"role": "system", "content": SYSTEM_PROMPT},
                  {"role": "user", "content": nlp_text}],
        temperature=0.0,
        max_tokens=4000,
    )
    hcl = r.choices[0].message.content.strip()
    if hcl.startswith("```"):
        lines = hcl.splitlines()[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        hcl = "\n".join(lines).strip()
    if not hcl:
        raise RuntimeError("DeepSeek returned empty content")

    prefix = f"tenants/{tenant_id}/requests/{request_id}"
    storage.put(f"{prefix}/main.tf", hcl.encode())
    storage.put(f"{prefix}/prompt.txt", nlp_text.encode())

    return {"s3_prefix": prefix, "hcl_preview": hcl[:500]}