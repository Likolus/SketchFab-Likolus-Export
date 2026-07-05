#!/usr/bin/env python3
"""fbx_inspect.py - targeted FBX binary inspector.

Reports compact info needed to diagnose rig/animation issues:
  - counts of each object type (Geometry, Model, Material, Video, Texture,
    Deformer, AnimationStack/Layer/CurveNode/Curve)
  - bone Model nodes: name, subclass (Mesh/LimbNode), Lcl Translation,
    Lcl Rotation, Lcl Scaling from Properties70
  - connection summary: how many OO links to scene root (id 0),
    bone->bone parent links, mesh->root, Geometry->Model, etc.

Usage: python fbx_inspect.py <file.fbx>
"""
import sys
import struct

def read_node(data, pos):
    end_offset, num_props, prop_len, name_len = struct.unpack('<IIIB', data[pos:pos+13])
    if end_offset == 0 and num_props == 0 and prop_len == 0 and name_len == 0:
        return None, pos + 13
    pos += 13
    name = data[pos:pos+name_len].decode('latin1')
    pos += name_len
    props = []
    for _ in range(num_props):
        p, pos = read_prop(data, pos)
        props.append(p)
    children = []
    while pos < end_offset - 13:
        child_end, _, _, child_name_len = struct.unpack('<IIIB', data[pos:pos+13])
        if child_end == 0 and child_name_len == 0:
            pos += 13
            break
        child, pos = read_node(data, pos)
        if child is None:
            break
        children.append(child)
    if pos < end_offset:
        pos = end_offset
    return {'name': name, 'props': props, 'children': children}, pos

def read_prop(data, pos):
    t = chr(data[pos]); pos += 1
    if t == 'S':
        ln = struct.unpack('<I', data[pos:pos+4])[0]; pos += 4
        val = data[pos:pos+ln]; pos += ln
        return ('S', val), pos
    elif t == 'Y':
        v = struct.unpack('<h', data[pos:pos+2])[0]; pos += 2; return ('Y', v), pos
    elif t == 'C':
        v = data[pos]; pos += 1; return ('C', v), pos
    elif t == 'I':
        v = struct.unpack('<i', data[pos:pos+4])[0]; pos += 4; return ('I', v), pos
    elif t == 'F':
        v = struct.unpack('<f', data[pos:pos+4])[0]; pos += 4; return ('F', v), pos
    elif t == 'D':
        v = struct.unpack('<d', data[pos:pos+8])[0]; pos += 8; return ('D', v), pos
    elif t == 'L':
        v = struct.unpack('<q', data[pos:pos+8])[0]; pos += 8; return ('L', v), pos
    elif t == 'd':
        ln = struct.unpack('<I', data[pos:pos+4])[0]; pos += 4
        pos += 4; pos += 4
        arr = struct.unpack('<%dd' % ln, data[pos:pos+ln*8]); pos += ln*8
        return ('d[]', list(arr)), pos
    elif t == 'i':
        ln = struct.unpack('<I', data[pos:pos+4])[0]; pos += 4
        pos += 4; pos += 4
        arr = struct.unpack('<%di' % ln, data[pos:pos+ln*4]); pos += ln*4
        return ('i[]', list(arr)), pos
    else:
        return ('?'+t, None), pos

def walk_nodes(node, callback, depth=0):
    callback(node, depth)
    for c in node.get('children', []):
        walk_nodes(c, callback, depth+1)

def find_children(node, name):
    return [c for c in node.get('children', []) if c['name'] == name]

def get_prop_string(prop):
    if prop[0] != 'S': return None
    try:
        return prop[1].decode('utf8')
    except:
        return prop[1].decode('latin1')

def get_prop_int(prop):
    if prop[0] in ('I','L','Y','C'): return prop[1]
    return None

def get_prop_double(prop):
    if prop[0] in ('D','F'): return prop[1]
    return None

def main():
    path = sys.argv[1]
    with open(path, 'rb') as f:
        data = f.read()
    version = struct.unpack('<I', data[23:27])[0]
    print(f'FBX version: {version}')
    print(f'File size: {len(data)} bytes')
    pos = 27
    top_nodes = []
    while pos < len(data):
        end_offset, num_props, prop_len, name_len = struct.unpack('<IIIB', data[pos:pos+13])
        if end_offset == 0 and num_props == 0 and prop_len == 0 and name_len == 0:
            break
        node, pos = read_node(data, pos)
        top_nodes.append(node)

    objects = None
    connections = None
    for n in top_nodes:
        if n['name'] == 'Objects': objects = n
        elif n['name'] == 'Connections': connections = n

    # ---- object type counts ----
    print('\n=== Object type counts (Objects section) ===')
    type_counts = {}
    bone_models = []  # (name, subclass, lcl_trans, lcl_rot, lcl_scale)
    mesh_models = []
    anim_stacks = []
    anim_curves_count = 0
    anim_curve_nodes = 0
    deformers = []
    if objects:
        for obj in objects['children']:
            # obj name = type (Geometry/Model/Material/Video/Texture/Deformer/AnimStack/AnimLayer/AnimCurveNode/AnimCurve)
            tname = obj['name']
            type_counts[tname] = type_counts.get(tname, 0) + 1
            # props: [L id, S name\x00\x01class, S subclass]
            if len(obj['props']) >= 3:
                id_val = get_prop_int(obj['props'][0]) if obj['props'][0][0] in ('L','I') else None
                name_raw = get_prop_string(obj['props'][1]) or ''
                # split on \x00\x01
                if '\x00\x01' in name_raw:
                    oname, oclass = name_raw.split('\x00\x01', 1)
                else:
                    oname, oclass = name_raw, ''
                subclass = get_prop_string(obj['props'][2]) or ''
            else:
                id_val = obj['props'][0][1] if obj['props'] else None
                oname = ''; oclass = ''; subclass = ''
            if tname == 'Model' and subclass == 'LimbNode':
                # parse Properties70 for Lcl Translation/Rotation/Scaling
                lt = lr = ls = None
                props70 = None
                for ch in obj['children']:
                    if ch['name'] == 'Properties70':
                        props70 = ch; break
                if props70:
                    for pnode in props70['children']:
                        if pnode['name'] != 'P' or not pnode['props']: continue
                        pname = get_prop_string(pnode['props'][0]) if pnode['props'][0][0]=='S' else ''
                        vals = pnode['props'][4:] if len(pnode['props']) > 4 else []
                        nums = [get_prop_double(v) for v in vals if v[0] in ('D','F')]
                        if pname == 'Lcl Translation' and len(nums) >= 3:
                            lt = [round(nums[0],4), round(nums[1],4), round(nums[2],4)]
                        elif pname == 'Lcl Rotation' and len(nums) >= 3:
                            lr = [round(nums[0],4), round(nums[1],4), round(nums[2],4)]
                        elif pname == 'Lcl Scaling' and len(nums) >= 3:
                            ls = [round(nums[0],4), round(nums[1],4), round(nums[2],4)]
                bone_models.append({'id': id_val, 'name': oname, 'lt': lt, 'lr': lr, 'ls': ls})
            elif tname == 'Model' and subclass == 'Mesh':
                mesh_models.append({'id': id_val, 'name': oname})
            elif tname == 'AnimationStack':
                anim_stacks.append({'id': id_val, 'name': oname})
            elif tname == 'AnimationCurve':
                anim_curves_count += 1
            elif tname == 'AnimationCurveNode':
                anim_curve_nodes += 1
            elif tname == 'Deformer':
                # subclass Cluster or Skin
                deformers.append({'id': id_val, 'name': oname, 'subclass': subclass})

    for t, c in sorted(type_counts.items()):
        print(f'  {t}: {c}')
    print(f'\nBone (LimbNode) Models: {len(bone_models)}')
    print(f'Mesh Models: {len(mesh_models)}')
    print(f'AnimationStacks: {len(anim_stacks)} -> {[s["name"] for s in anim_stacks]}')
    print(f'AnimationCurveNodes: {anim_curve_nodes}')
    print(f'AnimationCurves: {anim_curves_count}')
    print(f'Deformers: {len(deformers)} (Skin+Cluster)')

    # ---- bone details ----
    print('\n=== Bone (LimbNode) Models — first 15 ===')
    for b in bone_models[:15]:
        print(f'  id={b["id"]} name={b["name"]!r}')
        print(f'      Lcl Trans={b["lt"]}  Lcl Rot={b["lr"]}  Lcl Scale={b["ls"]}')
    if len(bone_models) > 15:
        # show summary of translations for the rest
        print(f'  ... ({len(bone_models)-15} more bones)')
        non_zero_trans = sum(1 for b in bone_models[15:] if b['lt'] and any(abs(v) > 0.001 for v in b['lt']))
        print(f'  Of remaining {len(bone_models)-15}: {non_zero_trans} have non-zero Lcl Translation')

    # ---- connections ----
    print('\n=== Connections summary ===')
    conn_list = []
    if connections:
        for cnode in connections['children']:
            if cnode['name'] != 'C': continue
            # props: [S type, L src, L dst, (S propname)]
            if len(cnode['props']) < 3: continue
            ctype = get_prop_string(cnode['props'][0]) if cnode['props'][0][0]=='S' else ''
            src = cnode['props'][1][1] if cnode['props'][1][0] in ('L','I') else None
            dst = cnode['props'][2][1] if cnode['props'][2][0] in ('L','I') else None
            pname = get_prop_string(cnode['props'][3]) if len(cnode['props']) > 3 and cnode['props'][3][0]=='S' else None
            conn_list.append((ctype, src, dst, pname))

    # build id->type map
    id_type = {}
    if objects:
        for obj in objects['children']:
            if len(obj['props']) >= 3 and obj['props'][0][0] in ('L','I'):
                oid = obj['props'][0][1]
                subclass = get_prop_string(obj['props'][2]) or ''
                id_type[oid] = (obj['name'], subclass)

    to_root = 0  # OO links to dst=0
    bone_to_parent = 0
    mesh_to_root = 0
    geo_to_model = 0
    mat_to_model = 0
    skin_to_geo = 0
    cluster_to_bone = 0
    cluster_to_skin = 0
    anim_layer_to_stack = 0
    anim_curvenode_to_layer = 0
    anim_curvenode_to_model = 0
    anim_curve_to_curvenode = 0
    other_oo = 0
    op_links = 0

    for ctype, src, dst, pname in conn_list:
        src_t = id_type.get(src, ('?','?'))
        dst_t = id_type.get(dst, ('?','?'))
        if ctype == 'OO' and dst == 0:
            to_root += 1
            if src_t[1] == 'LimbNode': bone_to_parent += 0  # bone->root counts as root link
            if src_t[1] == 'Mesh': mesh_to_root += 1
        elif ctype == 'OO':
            if src_t[0]=='Geometry' and dst_t[0]=='Model': geo_to_model += 1
            elif src_t[0]=='Model' and dst_t[0]=='Model' and src_t[1]=='LimbNode' and dst_t[1]=='LimbNode': bone_to_parent += 1
            elif src_t[0]=='Material' and dst_t[0]=='Model': mat_to_model += 1
            elif src_t[0]=='Deformer' and dst_t[1]=='Cluster' and dst_t[0]=='Deformer': cluster_to_skin += 1
            elif src_t[0]=='Deformer' and dst_t[0]=='Geometry' and src_t[1]=='Skin': skin_to_geo += 1
            elif src_t[0]=='Deformer' and dst_t[0]=='Model' and src_t[1]=='Cluster': cluster_to_bone += 1
            elif src_t[0]=='AnimationLayer' and dst_t[0]=='AnimationStack': anim_layer_to_stack += 1
            elif src_t[0]=='AnimationCurveNode' and dst_t[0]=='AnimationLayer': anim_curvenode_to_layer += 1
            elif src_t[0]=='AnimationCurveNode' and dst_t[0]=='Model': anim_curvenode_to_model += 1
            elif src_t[0]=='AnimationCurve' and dst_t[0]=='AnimationCurveNode': anim_curve_to_curvenode += 1
            else: other_oo += 1
        elif ctype == 'OP':
            op_links += 1

    print(f'  Total connections: {len(conn_list)}')
    print(f'  OO -> scene root (id 0): {to_root}  (mesh->root: {mesh_to_root})')
    print(f'  bone -> bone parent: {bone_to_parent}')
    print(f'  Geometry -> Model: {geo_to_model}')
    print(f'  Material -> Model: {mat_to_model}')
    print(f'  Skin -> Geometry: {skin_to_geo}')
    print(f'  Cluster -> Skin: {cluster_to_skin}')
    print(f'  Cluster -> bone Model: {cluster_to_bone}')
    print(f'  AnimLayer -> AnimStack: {anim_layer_to_stack}')
    print(f'  AnimCurveNode -> AnimLayer: {anim_curvenode_to_layer}')
    print(f'  AnimCurveNode -> Model: {anim_curvenode_to_model}')
    print(f'  AnimCurve -> AnimCurveNode: {anim_curve_to_curvenode}')
    print(f'  OP links (texture->material property): {op_links}')
    print(f'  other OO: {other_oo}')

    # ---- show bone->root vs bone->bone explicitly ----
    bone_root_links = [c for c in conn_list if c[0]=='OO' and c[2]==0 and id_type.get(c[1],('',''))[1]=='LimbNode']
    print(f'\n  Bone LimbNode -> root (id 0): {len(bone_root_links)}')
    print(f'  Bone LimbNode -> Bone LimbNode (parent): {bone_to_parent}')

if __name__ == '__main__':
    main()
