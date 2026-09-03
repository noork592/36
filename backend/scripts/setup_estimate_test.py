"""Ensure TEST PARTY GREEN has a price list assigned + a couple of items
have prices in that list, so the Estimates flow has real numbers to show."""
import asyncio, os, sys, uuid
from datetime import datetime, timezone
sys.path.insert(0, "/app/backend")
from dotenv import load_dotenv
load_dotenv("/app/backend/.env")
from motor.motor_asyncio import AsyncIOMotorClient

async def main():
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]
    now = datetime.now(timezone.utc).isoformat()

    # Pick or create a price list "Estimate Test List"
    pl = await db.price_lists.find_one({"name": "Estimate Test List"})
    if not pl:
        pl_id = str(uuid.uuid4())
        await db.price_lists.insert_one({
            "id": pl_id, "name": "Estimate Test List",
            "description": "Seed prices for estimate feature test", "created_at": now,
        })
        pl = {"id": pl_id, "name": "Estimate Test List"}
    pl_id = pl["id"]
    print("price_list_id =", pl_id)

    # Fetch 3 items — set prices 100, 150, 200
    items = await db.items.find({}, {"_id": 0, "id": 1, "name": 1, "product_name": 1}).limit(3).to_list(3)
    prices = [100.0, 150.0, 200.0]
    for it, price in zip(items, prices):
        await db.price_list_items.update_one(
            {"price_list_id": pl_id, "item_id": it["id"]},
            {"$set": {
                "price_list_id": pl_id, "item_id": it["id"],
                "item_name": it["name"], "product_name": it.get("product_name") or "",
                "price": price, "updated_at": now,
            }}, upsert=True,
        )
        print(f"  set {it['name']} → ₹{price}")

    # Assign this price list to TEST PARTY GREEN
    res = await db.customers.update_one(
        {"name": "TEST PARTY GREEN"},
        {"$set": {"price_list_id": pl_id}},
    )
    print("Assigned to TEST PARTY GREEN, matched:", res.matched_count)

    client.close()

asyncio.run(main())
