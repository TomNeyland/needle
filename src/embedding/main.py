from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import uvicorn
import os
from openai import AsyncOpenAI
from typing import List
from chromadb import EphemeralClient
import chromadb.utils.embedding_functions as embedding_functions
import uuid  # Import the UUID module for generating unique IDs
import math
import re  # Import the re module for regex operations

BATCH_SIZE = 25

# Get OpenAI API key from environment variable
NEEDLE_OPENAI_API_KEY = os.getenv("NEEDLE_OPENAI_API_KEY")
client = AsyncOpenAI(api_key=NEEDLE_OPENAI_API_KEY)

# Create embedding function with OpenAI
openai_ef = embedding_functions.OpenAIEmbeddingFunction(
                api_key=NEEDLE_OPENAI_API_KEY,
                model_name="text-embedding-3-small"
)

app = FastAPI()

print("[INFO] Using OpenAI embeddings via text-embedding-3-small (NEEDLE_OPENAI_API_KEY)")

# Initialize ChromaDB client
chroma_client = EphemeralClient()
collection_name = "code_embeddings"
collection = chroma_client.get_or_create_collection(name=collection_name, embedding_function=openai_ef)

# Log the number of entries in the collection
collection_count = collection.count()
print(f"[INFO] ChromaDB collection '{collection_name}' contains {collection_count} entries")

class BatchCodeInput(BaseModel):
    codes: List[str]

class FileEmbeddingInput(BaseModel):
    documents: List[dict]  # Each document contains "document" and "metadata"

class SearchQuery(BaseModel):
    query: str
    max_results: int = 15
    similarity_threshold: float = 0.2
    exclusion_pattern: str = ""  # Optional field for exclusion patterns
    inclusion_pattern: str = ""  # Optional field for inclusion patterns

@app.get("/healthz")
def health_check():
    return {"status": "ok", "mode": "openai"}

@app.post("/embed")
async def embed_code_batch(input: BatchCodeInput):
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
        # Truncate documents to a maximum of 1000 characters
        documents = [doc["document"][:1000] for doc in input.documents]
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

                # Check inclusion pattern if provided
                if hasattr(input, 'inclusion_pattern') and input.inclusion_pattern:
                    inclusion_pattern = input.inclusion_pattern
                    file_path = metadata.get("filePath", "")
                    if not should_include_file(file_path, inclusion_pattern):
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

def should_include_file(file_path: str, inclusion_pattern: str) -> bool:
    if not inclusion_pattern:
        return True  # If no inclusion pattern, include all files
    
    try:
        # Split by comma to support multiple patterns
        patterns = [pattern.strip() for pattern in inclusion_pattern.split(',') if pattern.strip()]
        
        # If no valid patterns after filtering, include all files
        if not patterns:
            return True
        
        for pattern in patterns:
            # Convert glob patterns to proper regex
            regex_pattern = pattern.replace('.', '\\.').replace('*', '.*').replace('{', '(').replace('}', ')').replace(',', '|')
            regex = re.compile(regex_pattern, re.IGNORECASE)
            if regex.search(file_path):
                return True
        
        # If no patterns matched, exclude the file
        return False
    except Exception as e:
        print(f"[ERROR] Invalid inclusion pattern: {inclusion_pattern}", e)
        return True  # On error, default to including files

if __name__ == "__main__":
    # Get port from environment variable or use default
    port = int(os.getenv("NEEDLE_SERVER_PORT", 8000))
    print(f"[INFO] Starting Needle embedding server on port {port}")
    uvicorn.run(app, host="127.0.0.1", port=port)
