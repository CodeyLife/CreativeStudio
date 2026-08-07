import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
const client = new S3Client({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:9000",
  forcePathStyle: true,
  credentials: { accessKeyId: "ymcp", secretAccessKey: "ymcp-minio-local" },
});
const key = "67/358af6c4642c572acc3a338389a3a899361a213bbf1468e5c75cc5321a903e";
const result = await client.send(new GetObjectCommand({ Bucket: "ymcp-novel", Key: key }));
const body = await result.Body?.transformToString("utf-8");
console.log("=== 第 1 章正文（revision 2）===");
console.log(body ?? "（空）");
