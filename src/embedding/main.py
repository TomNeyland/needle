from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from transformers import AutoTokenizer, AutoModel
import torch
import uvicorn
import os
from openai import AsyncOpenAI
from typing import List
from chromadb import Client
import chromadb.utils.embedding_functions as embedding_functions
import uuid  # Import the UUID module for generating unique IDs
import math
import re  # Import the re module for regex operations

BATCH_SIZE = 100

NEEDLE_OPENAI_API_KEY = os.getenv("NEEDLE_OPENAI_API_KEY")
OPENAI_API_KEY = NEEDLE_OPENAI_API_KEY  # For backward compatibility in code
client = AsyncOpenAI(api_key=OPENAI_API_KEY)

openai_ef = embedding_functions.OpenAIEmbeddingFunction(
                api_key=OPENAI_API_KEY,
                model_name="text-embedding-3-small"
)

app = FastAPI()

use_openai = OPENAI_API_KEY is not None

if use_openai:
    print("[INFO] Using OpenAI embeddings via text-embedding-3-small (NEEDLE_OPENAI_API_KEY)")
else:
    print("[INFO] Using local BGE model for embeddings.")
    model_name = "BAAI/bge-code"
    tokenizer = AutoTokenizer.from_pretrained(model_name)
    model = AutoModel.from_pretrained(model_name)
    model.eval()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model.to(device)

# Initialize ChromaDB client
chroma_client = Client()
collection_name = "code_embeddings"
collection = chroma_client.get_or_create_collection(name=collection_name, embedding_function=openai_ef)

class BatchCodeInput(BaseModel):
    codes: List[str]

class FileEmbeddingInput(BaseModel):
    documents: List[dict]  # Each document contains "document" and "metadata"

class SearchQuery(BaseModel):
    query: str
    max_results: int = 15
    similarity_threshold: float = 0.2
    exclusion_pattern: str = ""  # Optional field for exclusion patterns

@app.get("/healthz")
def health_check():
    return {"status": "ok", "mode": "openai" if use_openai else "local"}

@app.post("/embed")
async def embed_code_batch(input: BatchCodeInput):
    if use_openai:
        try:
            response = await client.embeddings.create(
                model="text-embedding-3-small",
                input=input.codes  # sending batch of strings
            )
            embeddings = [item.embedding for item in response.data]
            return {"embeddings": embeddings}
        except Exception as e:
            print("[ERROR] OpenAI API error:", str(e))
            raise HTTPException(status_code=500, detail=f"Unexpected error: {str(e)}")

    # Local model (for dev)
    embeddings = []
    for code in input.codes:
        text = f"Represent code for retrieval: {code.strip()}"
        inputs = tokenizer(text, return_tensors="pt", truncation=True, max_length=512, padding=True)
        inputs = {k: v.to(device) for k, v in inputs.items()}

        with torch.no_grad():
            model_output = model(**inputs)

        token_embeddings = model_output.last_hidden_state
        attention_mask = inputs['attention_mask']
        input_mask_expanded = attention_mask.unsqueeze(-1).expand(token_embeddings.size())
        sum_embeddings = torch.sum(token_embeddings * input_mask_expanded, dim=1)
        sum_mask = torch.clamp(input_mask_expanded.sum(dim=1), min=1e-9)
        embedding = (sum_embeddings / sum_mask).squeeze().cpu().tolist()
        embeddings.append(embedding)

    return {"embeddings": embeddings}

@app.post("/update_file_embeddings")
async def update_file_embeddings(input: FileEmbeddingInput):
    try:
        # Extract unique metadata keys and values from incoming documents
        metadata_filters = [
            {key: doc["metadata"][key] for key in ('filePath',)}
            for doc in input.documents
        ]

        # Clear existing embeddings for all provided metadata filters
        for metadata_filter in metadata_filters:
            collection.delete(where=metadata_filter)

        # Prepare data for a single batch call
        ids = [str(uuid.uuid4().hex) for _ in input.documents]
        documents = [doc["document"] for doc in input.documents]
        metadatas = [doc["metadata"] for doc in input.documents]

        # Process in batches of BATCH_SIZE
        total_docs = len(input.documents)
        total_batches = math.ceil(total_docs / BATCH_SIZE)
        
        for i in range(total_batches):
            start_idx = i * BATCH_SIZE
            end_idx = min((i + 1) * BATCH_SIZE, total_docs)
            
            # Add current batch
            collection.add(
                ids=ids[start_idx:end_idx],
                documents=documents[start_idx:end_idx],
                metadatas=metadatas[start_idx:end_idx]
            )

        return {"status": "success", "message": f"Updated embeddings for {len(input.documents)} documents"}
    except Exception as e:
        print("[ERROR] ChromaDB error:", str(e))
        raise HTTPException(status_code=500, detail=f"Unexpected error: {str(e)}")

@app.post("/search")
async def search_embeddings(input: SearchQuery):
    try:
        # Perform the search in ChromaDB
        # Fetch more results than max_results to account for exclusions
        extra_results_factor = 2  # Fetch twice the max_results to account for exclusions
        n_results_to_fetch = input.max_results * extra_results_factor
        results = collection.query(
            query_texts=[input.query],
            n_results=n_results_to_fetch
        )

        # Filter results based on similarity threshold and exclusion pattern
        filtered_results = []
        for doc, metadata, distance in zip(results["documents"][0], results["metadatas"][0], results["distances"][0]):
            # Normalize similarity to range [0, 1] where 1 is identical and 0 is not similar
            similarity = 1 - (distance / 2)
            if similarity >= input.similarity_threshold:
                # Check exclusion pattern if provided
                if hasattr(input, 'exclusion_pattern') and input.exclusion_pattern:
                    exclusion_pattern = input.exclusion_pattern
                    file_path = metadata.get("filePath", "")
                    if should_exclude_file(file_path, exclusion_pattern):
                        continue

                filtered_results.append({
                    "embedding": [],  # Embedding is not returned for search results
                    "code": doc,
                    "filePath": metadata["filePath"],
                    "lineStart": metadata["start_line"],
                    "lineEnd": metadata["end_line"],
                    "fingerprint": metadata.get("fingerprint", ""),
                    "context": metadata.get("context", ""),
                    "score": similarity  # Rename field to 'score' for UI compatibility
                })

            # Stop collecting results once we have enough after filtering
            if len(filtered_results) >= input.max_results:
                break

        return {"results": filtered_results[:input.max_results]}  # Return only the top max_results
    except Exception as e:
        print("[ERROR] ChromaDB search error:", str(e))
        raise HTTPException(status_code=500, detail=f"Unexpected error: {str(e)}")

def should_exclude_file(file_path: str, exclusion_pattern: str) -> bool:
    try:
        # Split by comma to support multiple patterns like "scss, py"
        patterns = [pattern.strip() for pattern in exclusion_pattern.split(',') if pattern.strip()]

        for pattern in patterns:
            # Convert glob patterns like *.{json,md} to proper regex
            regex_pattern = pattern.replace('.', '\\.').replace('*', '.*').replace('{', '(').replace('}', ')').replace(',', '|')
            regex = re.compile(regex_pattern, re.IGNORECASE)
            if regex.search(file_path):
                return True

        return False
    except Exception as e:
        print(f"[ERROR] Invalid exclusion pattern: {exclusion_pattern}", e)
        return False

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
