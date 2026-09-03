"""Seed a couple of price lists if the DB has none, so we can test the
Add-SKU-with-prices flow. Safe to run repeatedly."""
import asyncio, os, sys, uuid
from datetime import datetime, timezone

sys.path.insert(0, "/app/backend")
os.chdir("/app/backend")
from dotenv import load_dotenv
load_dotenv("/app/backend/.env")
from motor.motor_asyncio import AsyncIOMotorClient

async def main():
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]
    existing = await db.price_lists.count_documents({})
    print(f"Existing price lists: {existing}")
    if existing < 2:
        now = datetime.now(timezone.utc).isoformat()
        wanted = [
            {"name": "Retail A", "description": "Standard retail pricing"},
            {"name": "Wholesale B", "description": "Volume discount tier"},
            {"name": "Distributor C", "description": "Regional distributor rates"},
        ]
        for w in wanted:
            found = await db.price_lists.find_one({"name": w["name"]})
            if not found:
                await db.price_lists.insert_one({
                    "id": str(uuid.uuid4()), "name": w["name"],
                    "description": w["description"], "created_at": now,
                })
                print(f"Inserted price list: {w['name']}")
    total = await db.price_lists.count_documents({})
    print(f"Total price lists now: {total}")
    client.close()

asyncio.run(main())
