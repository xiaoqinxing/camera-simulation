# 人物模型来源及署名

人物：`HSR0040-Body-023`，来自 **HSRD-100: 100 High-Quality 3D Human Scans Dataset**，作者 Digital Reality Lab / HumanScanRepository，2025。原始数据：https://huggingface.co/datasets/digitalrealitylab/HSRD-100 ，许可 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。

本项目使用由 Lichtwerk Studio 转换的 `hsrd-hsr0040-body-023.glb`，来源 https://lichtwerk.cam/studio/scans/hsrd-hsr0040-body-023.glb 。其转换包括坐标方向、统一身高及 GLB/纹理编码，详见同目录 `HSRD-PROVENANCE.md`。本项目进一步将纹理由 8192×8192 缩至 3072×3072 并重新编码为 JPEG，使用 glTF Transform Meshopt 量化、重排和压缩几何数据以改善网络下载；保留完整人体及三角面。运行时另进行统一缩放、旋转和平移。

源数据作者提出的伦理建议包括不用于监控、敏感生物识别和医疗诊断。CC BY 不授予肖像权、隐私权或商标权；使用者应自行确保其使用符合适用要求。许可全文见 `LICENSE-HSRD-CC-BY-4.0.txt`。
