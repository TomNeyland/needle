from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from transformers import AutoTokenizer, AutoModel
import torch
import uvicorn
import os
from openai import AsyncOpenAI
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")

client = AsyncOpenAI(api_key=OPENAI_API_KEY)

app = FastAPI()

use_openai = OPENAI_API_KEY is not None

if use_openai:
    print("[INFO] Using OpenAI embeddings via text-embedding-3-small")
else:
    print("[INFO] Using local BGE model for embeddings.")
    model_name = "BAAI/bge-code"
    tokenizer = AutoTokenizer.from_pretrained(model_name)
    model = AutoModel.from_pretrained(model_name)
    model.eval()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model.to(device)

class CodeInput(BaseModel):
    code: str

@app.get("/healthz")
def health_check():
    return {"status": "ok", "mode": "openai" if use_openai else "local"}

@app.post("/embed")
async def embed_code(input: CodeInput):
    if use_openai:
        try:
            response = await client.embeddings.create(model="text-embedding-3-large",  # or "text-embedding-3-small"
            input=input.code)
            embedding = response.data[0].embedding
            return {"embedding": embedding}
        except Exception as e:
            print("[ERROR] OpenAI API error:", str(e))
            raise HTTPException(status_code=500, detail=f"Unexpected error: {str(e)}")

    # Local fallback
    text = f"Represent code for retrieval: {input.code.strip()}"
    inputs = tokenizer(text, return_tensors="pt", truncation=True, max_length=512, padding=True)
    inputs = {k: v.to(device) for k, v in inputs.items()}

    with torch.no_grad():
        model_output = model(**inputs)

    token_embeddings = model_output.last_hidden_state
    attention_mask = inputs['attention_mask']
    input_mask_expanded = attention_mask.unsqueeze(-1).expand(token_embeddings.size())
    sum_embeddings = torch.sum(token_embeddings * input_mask_expanded, dim=1)
    sum_mask = torch.clamp(input_mask_expanded.sum(dim=1), min=1e-9)
    embeddings = (sum_embeddings / sum_mask).squeeze().cpu().tolist()

    return {"embedding": embeddings}

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)