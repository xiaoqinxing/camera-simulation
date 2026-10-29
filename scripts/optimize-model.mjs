import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

const input = 'source-assets/hsrd-hsr0040-body-023.glb';
const output = 'public/assets/hsrd-hsr0040-body-023-web.glb';
const expected = '535bc52e341b02fb135992ad21e880a748a1bd79ac10c87849e78492a5fd55a3';
const hash = createHash('sha256').update(await readFile(input)).digest('hex');
if (hash !== expected) throw new Error(`源模型校验失败: ${hash}`);
await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const document = await io.read(input);
for (const texture of document.getRoot().listTextures()) {
  const image = texture.getImage();
  if (!image) throw new Error('源模型纹理为空');
  texture.setImage(await sharp(image).resize(3072, 3072, { fit: 'inside' }).jpeg({ quality: 82, mozjpeg: true }).toBuffer());
  texture.setMimeType('image/jpeg');
}
await document.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
await io.write(output, document);
console.log(`已生成 ${output}；SHA-256: ${createHash('sha256').update(await readFile(output)).digest('hex')}`);
