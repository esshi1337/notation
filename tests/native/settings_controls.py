"""User interactions shared by native Settings acceptance checks."""
import json
import smoke


def selected_segment(client, name):
    return client.execute("const name=arguments[0];const group=[...document.querySelectorAll('[role=radiogroup]')].find(e=>(e.getAttribute('aria-label')||document.getElementById(e.getAttribute('aria-labelledby'))?.textContent)===name);return group?.querySelector('[aria-checked=true]')?.textContent.trim()", [name])


def segment(client, name, label):
    group = '//*[@role="radiogroup" and (@aria-label=' + json.dumps(name) + ' or ../span[normalize-space(.)=' + json.dumps(name) + '])]'
    button = client.find(group + '//*[@role="radio" and normalize-space(.)=' + json.dumps(label) + ']', using='xpath')
    client.element_command(button, '/click')
    smoke.require(selected_segment(client, name) == label, name + ' did not select ' + label)


def select(client, name, label):
    client.element_command(client.find('[role="combobox"][aria-label=' + json.dumps(name) + ']'), '/click')
    client.element_command(client.find('//*[@role="option" and starts-with(normalize-space(.),' + json.dumps(label) + ')]', using='xpath'), '/click')
