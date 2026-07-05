#!/usr/bin/env python
"""
validate_obj_in_blender.py
==========================
Headless validation of an OBJ (+MTL+textures) via Blender's OBJ importer.
Produces a JSON report identical in structure to validate_fbx_in_blender.py
so we can compare what's actually inside the OBJ.

USAGE:
    blender --background --python validate_obj_in_blender.py -- "model.obj" "report.json"
"""
import bpy
import sys
import json
import os
import mathutils
from io import StringIO
from contextlib import redirect_stdout, redirect_stderr

argv = sys.argv
if "--" in argv:
    argv = argv[argv.index("--") + 1:]
else:
    argv = []

if not argv:
    print("ERROR: usage: blender --background --python validate_obj_in_blender.py -- <obj_path> [report_path]")
    sys.exit(1)

obj_path = argv[0]
report_path = argv[1] if len(argv) > 1 else None

if not os.path.isfile(obj_path):
    print("ERROR: OBJ file not found: " + obj_path)
    sys.exit(1)

import_log = StringIO()
err_log = StringIO()

# Reset scene to empty
bpy.ops.wm.read_factory_settings(use_empty=True)

# Import OBJ
import_ok = True
import_exception = None
try:
    with redirect_stdout(import_log), redirect_stderr(err_log):
        # Blender 3.x+: use wm.obj_import
        try:
            bpy.ops.wm.obj_import(filepath=obj_path)
        except AttributeError:
            # Older API (Blender 2.8-3.1)
            bpy.ops.import_scene.obj(filepath=obj_path)
except Exception as e:
    import_ok = False
    import_exception = repr(e)
    err_log.write("\nIMPORT EXCEPTION: " + repr(e) + "\n")


def scene_bbox():
    mins = [ float('inf')] * 3
    maxs = [-float('inf')] * 3
    seen = False
    for obj in bpy.data.objects:
        if obj.type != 'MESH':
            continue
        if obj.data.vertices is None or len(obj.data.vertices) == 0:
            continue
        for corner in obj.bound_box:
            world_corner = obj.matrix_world @ mathutils.Vector(corner)
            for i in range(3):
                v = world_corner[i]
                if v < mins[i]: mins[i] = v
                if v > maxs[i]: maxs[i] = v
            seen = True
    if not seen:
        return None
    return {
        "min": [round(m, 6) for m in mins],
        "max": [round(m, 6) for m in maxs],
        "size": [round(maxs[i] - mins[i], 6) for i in range(3)],
        "center": [round((maxs[i] + mins[i]) / 2, 6) for i in range(3)],
    }


def bone_tree(armature_obj):
    if armature_obj.data is None or armature_obj.data.bones is None:
        return {"bone_count": 0, "roots": []}
    def describe(bone):
        return {
            "name": bone.name,
            "children": [describe(c) for c in bone.children],
            "head": [round(x, 6) for x in bone.head_local],
            "tail": [round(x, 6) for x in bone.tail_local],
        }
    roots = [b for b in armature_obj.data.bones if b.parent is None]
    return {"bone_count": len(armature_obj.data.bones), "roots": [describe(r) for r in roots]}


meshes_report = []
armatures_report = []
actions_report = []
objects_overview = []

for obj in bpy.data.objects:
    entry = {
        "name": obj.name,
        "type": obj.type,
        "location": [round(x, 6) for x in obj.location],
        "rotation_euler": [round(x, 6) for x in obj.rotation_euler],
        "scale": [round(x, 6) for x in obj.scale],
        "parent": obj.parent.name if obj.parent else None,
        "visible": obj.visible_get(),
    }
    objects_overview.append(entry)
    if obj.type == 'MESH':
        mesh = obj.data
        nan_count = 0
        for v in mesh.vertices:
            for c in v.co:
                if c != c or c == float('inf') or c == -float('inf'):
                    nan_count += 1
                    break
        areas = [p.area for p in mesh.polygons]
        zero_area = sum(1 for a in areas if a <= 0)
        mats = [s.material.name if s.material else None for s in obj.material_slots]
        uvs = [uv.name for uv in mesh.uv_layers]
        vg = [g.name for g in obj.vertex_groups]
        mods = [{"name": m.name, "type": m.type} for m in obj.modifiers]
        # Material textures
        mat_textures = []
        for slot in obj.material_slots:
            if not slot.material:
                continue
            if slot.material.node_tree:
                for nt in slot.material.node_tree.nodes:
                    if nt.type == 'TEX_IMAGE' and nt.image:
                        mat_textures.append({
                            "material": slot.material.name,
                            "image": nt.image.name,
                            "filepath": nt.image.filepath,
                            "size": list(nt.image.size),
                            "has_pixels": nt.image.has_data if hasattr(nt.image, 'has_data') else None,
                        })
        meshes_report.append({
            "name": obj.name,
            "vertex_count": len(mesh.vertices),
            "face_count": len(mesh.polygons),
            "edge_count": len(mesh.edges),
            "uv_layers": uvs,
            "vertex_groups": vg,
            "modifiers": mods,
            "materials": mats,
            "textures": mat_textures,
            "vertex_nan_count": nan_count,
            "zero_area_faces": zero_area,
            "total_area": round(sum(areas), 6),
            "min_face_area": round(min(areas), 6) if areas else 0,
            "max_face_area": round(max(areas), 6) if areas else 0,
            "bbox_local": {
                "min": [round(x, 6) for x in obj.bound_box[0]],
                "max": [round(x, 6) for x in obj.bound_box[6]],
            },
            "matrix_world": [[round(x, 6) for x in row] for row in obj.matrix_world],
            "parent_armature": obj.parent.name if (obj.parent and obj.parent.type == 'ARMATURE') else None,
        })
    elif obj.type == 'ARMATURE':
        armatures_report.append({
            "name": obj.name,
            "bone_hierarchy": bone_tree(obj),
            "pose_bones": [b.name for b in obj.pose.bones] if obj.pose else [],
        })

for action in bpy.data.actions:
    actions_report.append({
        "name": action.name,
        "frame_range": [round(action.frame_range[0], 3), round(action.frame_range[1], 3)],
        "fcurve_count": len(action.fcurves),
        "total_keyframes": sum(len(fc.keyframe_points) for fc in action.fcurves),
    })

report = {
    "obj_path": obj_path,
    "file_size_bytes": os.path.getsize(obj_path),
    "blender_version": bpy.app.version_string,
    "import_success": import_ok,
    "import_exception": import_exception,
    "import_stdout": import_log.getvalue().strip().splitlines(),
    "import_stderr": err_log.getvalue().strip().splitlines(),
    "scene_summary": {
        "total_objects": len(bpy.data.objects),
        "mesh_count": sum(1 for o in bpy.data.objects if o.type == 'MESH'),
        "armature_count": sum(1 for o in bpy.data.objects if o.type == 'ARMATURE'),
        "empty_count": sum(1 for o in bpy.data.objects if o.type == 'EMPTY'),
        "action_count": len(bpy.data.actions),
        "material_count": len(bpy.data.materials),
        "image_count": len(bpy.data.images),
        "scene_bbox": scene_bbox(),
    },
    "objects_overview": objects_overview,
    "meshes": meshes_report,
    "armatures": armatures_report,
    "actions": actions_report,
}

# Quick verdict for OBJ specifically
verdict = []
if not import_ok:
    verdict.append("IMPORT FAILED: " + str(import_exception))
elif report["scene_summary"]["mesh_count"] == 0:
    verdict.append("OBJ imported but 0 meshes in scene.")
if report["scene_summary"]["armature_count"] == 0:
    verdict.append("No armatures imported — OBJ does NOT support rigs/skeletons natively.")
if report["scene_summary"]["action_count"] == 0:
    verdict.append("No animation actions — OBJ does NOT support animation natively.")
if report["scene_summary"]["mesh_count"] > 0:
    any_verts = any(m["vertex_count"] > 0 for m in meshes_report)
    if not any_verts:
        verdict.append("Meshes exist but ALL have 0 vertices.")
    any_zero = any(m["zero_area_faces"] > 0 for m in meshes_report)
    if any_zero:
        verdict.append("Some meshes have zero-area faces (degenerate).")
bbox = report["scene_summary"]["scene_bbox"]
if bbox:
    size = bbox["size"]
    if max(size) < 0.001:
        verdict.append("Scene bbox is tiny (<1mm).")
    if max(size) > 100000:
        verdict.append("Scene bbox is huge (>100km).")
if not verdict:
    verdict.append("OBJ imported cleanly — geometry + materials + textures visible. No rig (OBJ cannot store one).")
report["verdict"] = verdict

json_str = json.dumps(report, indent=2, ensure_ascii=False)
if report_path:
    with open(report_path, "w", encoding="utf-8") as f:
        f.write(json_str)
    print("Report written to: " + report_path)
else:
    print(json_str)

print("=" * 70)
print("OBJ DIAGNOSTIC SUMMARY")
print("=" * 70)
print("Import success : " + str(report["import_success"]))
print("Meshes         : " + str(report["scene_summary"]["mesh_count"]))
print("Armatures      : " + str(report["scene_summary"]["armature_count"]) + "  (OBJ cannot store rigs)")
print("Actions        : " + str(report["scene_summary"]["action_count"]) + "  (OBJ cannot store animation)")
print("Materials      : " + str(report["scene_summary"]["material_count"]))
print("Images         : " + str(report["scene_summary"]["image_count"]))
if bbox:
    print("BBox size      : " + str(bbox["size"]))
    print("BBox center    : " + str(bbox["center"]))
print("-" * 70)
for v in verdict:
    print(" * " + v)
print("=" * 70)
