-- CreateTable
CREATE TABLE "kyneta_meta" (
    "doc_id" TEXT NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "kyneta_meta_pkey" PRIMARY KEY ("doc_id")
);

-- CreateTable
CREATE TABLE "kyneta_records" (
    "doc_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" TEXT,
    "blob" BYTEA,

    CONSTRAINT "kyneta_records_pkey" PRIMARY KEY ("doc_id","seq")
);
